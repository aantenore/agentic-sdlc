import path from "node:path";

import { crypto } from "../runtime/host.mjs";
import {
  DEFAULT_OPERATIONAL_REDACTION_POLICY,
  REDACTION_LIMIT_PLACEHOLDER,
  createRedactionPolicy,
  redactText,
  redactValueWithMetadata,
} from "../observability/redaction.mjs";

import {
  CANONICAL_SOURCE_EXTENSIONS,
  OBSERVATORY_SOURCE_SCHEMA_VERSION,
  normalizeObservatoryLimits,
} from "./constants.mjs";
import {
  ObservatoryPathError,
  normalizePortableRelativePath,
  resolveExistingFileWithin,
  resolveKnowledgeBaseBoundary,
} from "./path-safety.mjs";
import {
  INTENTABI_REDACTED_OBSERVATION_PATH,
  isCanonicalIntentAbiObservationPath,
  isIntentAbiCodexEnvelopeCandidate,
  isIntentAbiObservationPath,
  projectIntentAbiCodexEnvelope,
} from "./intentabi-adapter.mjs";
import { readResolvedFileBounded } from "./bounded-file-reader.mjs";

const DERIVED_PREFIXES = [".sdlc/cache", ".sdlc/indexes"];
// Can hold the messaging topic; never served.
const SETTINGS_SOURCE_PATHS = new Set([".sdlc/messaging.json"]);
const PRIVATE_REASONING_KEYS = new Set([
  "chainofthought",
  "internalreasoning",
  "privatereasoning",
  "reasoningtrace",
]);
const PRIVATE_REASONING_FLAG_KEYS = new Set(["chainofthoughtincluded"]);
const PRIVATE_REASONING_SCAN_MAX_DEPTH = 512;
const PRIVATE_REASONING_SCAN_MAX_NODES = 25_000;
const ALLOWED_SOURCE_EXTENSIONS = new Set(CANONICAL_SOURCE_EXTENSIONS);

export async function readSourceRecord(projectRoot, relativePath, options = {}) {
  const limits = normalizeObservatoryLimits(options.limits);
  const redactionPolicy = resolveRedactionPolicy(options);
  const boundary = await resolveKnowledgeBaseBoundary(projectRoot);
  const normalized = normalizePortableRelativePath(relativePath, { requiredPrefix: ".sdlc" });
  const policyPath = normalized.toLowerCase();

  if (DERIVED_PREFIXES.some((prefix) => policyPath === prefix || policyPath.startsWith(`${prefix}/`))) {
    throw new ObservatoryPathError(
      "derived_source_forbidden",
      "Derived cache and index files are not canonical source records",
      403,
    );
  }

  if (SETTINGS_SOURCE_PATHS.has(policyPath)) {
    throw new ObservatoryPathError(
      "settings_source_forbidden",
      "Plugin settings are not canonical source records",
      403,
    );
  }

  const knowledgeBaseRelative = normalized.slice(".sdlc/".length);
  if (!knowledgeBaseRelative || normalized === ".sdlc") {
    throw new ObservatoryPathError("source_not_file", "The requested source record is not a file", 404);
  }
  if (!ALLOWED_SOURCE_EXTENSIONS.has(path.posix.extname(normalized).toLowerCase())) {
    throw new ObservatoryPathError(
      "source_format_forbidden",
      "Only canonical JSON, JSONL, Markdown, and text evidence may be inspected",
      403,
    );
  }
  const resolved = await resolveExistingFileWithin(boundary.knowledgeBaseRoot, knowledgeBaseRelative);
  const buffer = await readResolvedFileBounded(resolved, {
    maxBytes: limits.maxSourceBytes,
    boundaryCode: "source_boundary_changed",
    tooLargeCode: "source_too_large",
    tooLargeMessage: "The requested source record exceeds the configured response limit",
  });

  const content = buffer.toString("utf8");
  const format = sourceFormat(normalized);
  const response = {
    schemaVersion: OBSERVATORY_SOURCE_SCHEMA_VERSION,
    path: redactText(normalized, redactionPolicy),
    format,
    sizeBytes: buffer.byteLength,
    sha256: crypto.createHash("sha256").update(buffer).digest("hex"),
    provenance: "recorded",
    redactions: [],
    truncated: false,
  };

  if (isIntentAbiObservationPath(normalized)) omitIntentAbiFileMetadata(response);

  if (
    isIntentAbiObservationPath(normalized)
    && !isCanonicalIntentAbiObservationPath(normalized)
  ) {
    response.path = INTENTABI_REDACTED_OBSERVATION_PATH;
    response.provenance = "malformed";
    response.parseError = "invalid_intentabi_path";
    response.contentOmitted = true;
    response.redactions.push("");
    return finalizeSourceResponse(response, redactionPolicy);
  }

  if (format === "json") {
    try {
      const data = JSON.parse(content);
      if (isIntentAbiCodexEnvelopeCandidate(data, normalized)) {
        omitIntentAbiFileMetadata(response);
        const projection = projectIntentAbiCodexEnvelope(data);
        if (!projection || !isCanonicalIntentAbiObservationPath(normalized, projection.eventId)) {
          if (!isCanonicalIntentAbiObservationPath(normalized)) {
            response.path = INTENTABI_REDACTED_OBSERVATION_PATH;
          }
          response.provenance = "malformed";
          response.parseError = projection
            ? "invalid_intentabi_path"
            : "invalid_intentabi_envelope";
          response.contentOmitted = true;
          response.redactions.push("");
          return finalizeSourceResponse(response, redactionPolicy);
        }
        const presented = redactStructuredPresentation(projection, redactionPolicy);
        if (presented.limited) {
          omitPresentedContent(response, "presentation_redaction_limited");
          return finalizeSourceResponse(response, redactionPolicy);
        }
        response.data = presented.value;
        if (presented.redactions > 0) response.redactions.push("");
        response.contentProjection = "intentabi-observatory:v1";
        return finalizeSourceResponse(response, redactionPolicy);
      }
      const redacted = redactPrivateReasoning(data, response.redactions, "");
      if (redacted.limited) {
        omitPresentedContent(response, "private_reasoning_scan_limited");
        setRepresentationMetadata(response, REDACTION_LIMIT_PLACEHOLDER);
        return finalizeSourceResponse(response, redactionPolicy);
      }
      const presented = redactStructuredPresentation(redacted.data, redactionPolicy);
      if (presented.limited) {
        omitPresentedContent(response, "presentation_redaction_limited");
        setRepresentationMetadata(response, REDACTION_LIMIT_PLACEHOLDER);
        return finalizeSourceResponse(response, redactionPolicy);
      }
      response.data = presented.value;
      if (presented.redactions > 0) response.redactions.push("");
      if (response.redactions.length > 0) {
        setRepresentationMetadata(response, JSON.stringify(response.data));
      }
    } catch {
      omitPresentedContent(response, "invalid_json");
      setRepresentationMetadata(response, "[CONTENT OMITTED]");
    }
    return finalizeSourceResponse(response, redactionPolicy);
  }

  if (format === "jsonl") {
    const lines = content.split(/\r?\n/);
    const lineLimit = Math.min(lines.length, limits.maxJsonLines);
    response.entries = [];
    response.truncated = lines.length > limits.maxJsonLines;
    let representationChanged = false;
    for (let index = 0; index < lineLimit; index += 1) {
      const raw = lines[index].trim();
      if (raw === "") continue;
      try {
        const data = JSON.parse(raw);
        if (isIntentAbiCodexEnvelopeCandidate(data, normalized)) {
          omitIntentAbiFileMetadata(response);
          const projection = projectIntentAbiCodexEnvelope(data);
          if (!projection || !isCanonicalIntentAbiObservationPath(normalized, projection.eventId)) {
            if (!isCanonicalIntentAbiObservationPath(normalized)) {
              response.path = INTENTABI_REDACTED_OBSERVATION_PATH;
            }
            response.entries.push({
              line: index + 1,
              parseError: projection
                ? "invalid_intentabi_path"
                : "invalid_intentabi_envelope",
              provenance: "malformed",
              contentOmitted: true,
            });
            response.redactions.push(`/${index}`);
            response.provenance = "malformed";
            continue;
          }
          response.entries.push({
            line: index + 1,
            data: projection,
            provenance: "recorded",
            contentProjection: "intentabi-observatory:v1",
          });
          const presented = redactStructuredPresentation(projection, redactionPolicy);
          if (presented.limited) {
            response.entries[response.entries.length - 1] = omittedJsonLine(
              index + 1,
              "presentation_redaction_limited",
            );
            response.redactions.push(`/${index}`);
            response.provenance = "malformed";
            representationChanged = true;
            continue;
          }
          response.entries[response.entries.length - 1].data = presented.value;
          if (presented.redactions > 0) {
            response.redactions.push(`/${index}`);
            representationChanged = true;
          }
          continue;
        }
        const redacted = redactPrivateReasoning(data, response.redactions, `/${index}`);
        if (redacted.limited) {
          response.entries.push(omittedJsonLine(index + 1, "private_reasoning_scan_limited"));
          response.redactions.push(`/${index}`);
          response.provenance = "malformed";
          representationChanged = true;
          continue;
        }
        const presented = redactStructuredPresentation(redacted.data, redactionPolicy);
        if (presented.limited) {
          response.entries.push(omittedJsonLine(index + 1, "presentation_redaction_limited"));
          response.redactions.push(`/${index}`);
          response.provenance = "malformed";
          representationChanged = true;
          continue;
        }
        response.entries.push({
          line: index + 1,
          data: presented.value,
          provenance: "recorded",
        });
        if (presented.redactions > 0) {
          response.redactions.push(`/${index}`);
          representationChanged = true;
        }
        if (response.redactions.some((pointer) => pointer.startsWith(`/${index}/`))) {
          representationChanged = true;
        }
      } catch {
        response.entries.push(omittedJsonLine(index + 1, "invalid_json"));
        response.redactions.push(`/${index}`);
        response.provenance = "malformed";
        representationChanged = true;
      }
    }
    response.redactions = uniqueStrings(response.redactions);
    if (representationChanged && !isIntentAbiObservationPath(normalized)) {
      setRepresentationMetadata(response, serializeJsonLinesPresentation(response.entries));
    }
    return finalizeSourceResponse(response, redactionPolicy);
  }

  const presented = redactValueWithMetadata(content, redactionPolicy);
  if (presented.limited) {
    omitPresentedContent(response, "presentation_redaction_limited");
    setRepresentationMetadata(response, REDACTION_LIMIT_PLACEHOLDER);
    return finalizeSourceResponse(response, redactionPolicy);
  }
  const presentedText = presented.value;
  response.content = presentedText;
  if (presented.redactions > 0) {
    response.redactions.push("");
    setRepresentationMetadata(response, presentedText);
  }
  return finalizeSourceResponse(response, redactionPolicy);
}

function resolveRedactionPolicy(options) {
  if (options.redactionPolicy !== undefined) return options.redactionPolicy;
  if (options.redaction !== undefined) return createRedactionPolicy(options.redaction);
  return DEFAULT_OPERATIONAL_REDACTION_POLICY;
}

function redactStructuredPresentation(value, policy) {
  const presented = redactValueWithMetadata(value, policy);
  if (presented.limited || !containsUnsafePropertyName(presented.value, policy)) {
    return presented;
  }
  return {
    value: REDACTION_LIMIT_PLACEHOLDER,
    redactions: presented.redactions,
    limited: true,
    limit: "unsafePropertyName",
  };
}

function containsUnsafePropertyName(value, policy) {
  if (!isStructuredValue(value)) return false;
  const limits = policy.limits;
  const seen = new WeakSet();
  const stack = [{ value, depth: 0 }];
  let inspected = 0;

  while (stack.length > 0) {
    const current = stack.pop();
    if (!isStructuredValue(current.value) || seen.has(current.value)) continue;
    seen.add(current.value);
    inspected += 1;
    if (inspected > limits.maxNodes || current.depth > limits.maxDepth) return true;
    if (Array.isArray(current.value)) {
      for (const item of current.value) stack.push({ value: item, depth: current.depth + 1 });
      continue;
    }
    for (const [key, item] of Object.entries(current.value)) {
      if (redactText(key, policy) !== key) return true;
      stack.push({ value: item, depth: current.depth + 1 });
    }
  }
  return false;
}

function finalizeSourceResponse(response, policy) {
  for (const pointer of response.redactions) {
    if (redactText(pointer, policy) === pointer) continue;
    const contentFree = !Object.hasOwn(response, "sha256") && !Object.hasOwn(response, "sizeBytes");
    omitPresentedContent(response, "presentation_redaction_limited");
    if (!contentFree) setRepresentationMetadata(response, REDACTION_LIMIT_PLACEHOLDER);
    break;
  }
  response.redactions = uniqueStrings(response.redactions);
  return response;
}

function omitPresentedContent(response, parseError) {
  response.provenance = "malformed";
  response.parseError = parseError;
  response.contentOmitted = true;
  response.redactions = [""];
  delete response.data;
  delete response.entries;
  delete response.content;
}

function omittedJsonLine(line, parseError) {
  return {
    line,
    parseError,
    provenance: "malformed",
    contentOmitted: true,
  };
}

function serializeJsonLinesPresentation(entries) {
  if (entries.length === 0) return "";
  return `${entries.map((entry) => entry.data === undefined
    ? "[CONTENT OMITTED]"
    : JSON.stringify(entry.data)).join("\n")}\n`;
}

function setRepresentationMetadata(response, representation) {
  const buffer = Buffer.from(representation, "utf8");
  response.sizeBytes = buffer.byteLength;
  response.sha256 = crypto.createHash("sha256").update(buffer).digest("hex");
}

function uniqueStrings(values) {
  return [...new Set(values)];
}

function redactPrivateReasoning(value, redactions, pointer) {
  if (!isStructuredValue(value)) return { data: value, limited: false };
  const data = Array.isArray(value) ? [] : Object.create(null);
  const stack = [{
    kind: "container",
    source: value,
    target: data,
    pointer,
    depth: 0,
  }];
  let inspectedNodes = 0;

  while (stack.length > 0) {
    const frame = stack.pop();
    inspectedNodes += 1;
    if (
      inspectedNodes > PRIVATE_REASONING_SCAN_MAX_NODES
      || frame.depth > PRIVATE_REASONING_SCAN_MAX_DEPTH
    ) {
      return { data: null, limited: true };
    }

    if (frame.kind === "redact") {
      frame.target[frame.key] = "[redacted]";
      redactions.push(frame.pointer);
      continue;
    }
    if (frame.kind === "value") {
      if (!isStructuredValue(frame.value)) {
        frame.target[frame.key] = frame.value;
        continue;
      }
      const child = Array.isArray(frame.value) ? [] : Object.create(null);
      frame.target[frame.key] = child;
      stack.push({
        kind: "container",
        source: frame.value,
        target: child,
        pointer: frame.pointer,
        depth: frame.depth,
      });
      continue;
    }

    if (Array.isArray(frame.source)) {
      frame.target.length = frame.source.length;
      for (let index = frame.source.length - 1; index >= 0; index -= 1) {
        stack.push({
          kind: "value",
          value: frame.source[index],
          target: frame.target,
          key: index,
          pointer: `${frame.pointer}/${index}`,
          depth: frame.depth + 1,
        });
      }
      continue;
    }

    const entries = Object.entries(frame.source);
    const flaggedNarrative = entries.some(
      ([key, item]) => PRIVATE_REASONING_FLAG_KEYS.has(normalizeSensitiveKey(key)) && item === true,
    );
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const [key, item] = entries[index];
      const itemPointer = `${frame.pointer}/${escapeJsonPointer(key)}`;
      const sensitiveKey = normalizeSensitiveKey(key);
      if (
        PRIVATE_REASONING_KEYS.has(sensitiveKey)
        || (flaggedNarrative && !PRIVATE_REASONING_FLAG_KEYS.has(sensitiveKey))
      ) {
        stack.push({
          kind: "redact",
          target: frame.target,
          key,
          pointer: itemPointer,
          depth: frame.depth + 1,
        });
        continue;
      }
      stack.push({
        kind: "value",
        value: item,
        target: frame.target,
        key,
        pointer: itemPointer,
        depth: frame.depth + 1,
      });
    }
  }
  return { data, limited: false };
}

function isStructuredValue(value) {
  return value !== null && typeof value === "object";
}

function omitIntentAbiFileMetadata(response) {
  delete response.sha256;
  delete response.sizeBytes;
}

function normalizeSensitiveKey(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]/g, "");
}

function sourceFormat(publicPath) {
  const extension = path.posix.extname(publicPath).toLowerCase();
  if (extension === ".json") return "json";
  if (extension === ".jsonl") return "jsonl";
  if ([".md", ".markdown"].includes(extension)) return "markdown";
  return "text";
}

function escapeJsonPointer(value) {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}
