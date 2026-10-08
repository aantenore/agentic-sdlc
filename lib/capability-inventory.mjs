import path from "node:path";
import { fail } from "./cli/user-error.mjs";
import { fs, os, process } from "./runtime/host.mjs";

/**
 * Read-only discovery of the skills, commands, plugins, and MCP servers that
 * are already installed for the current user and project.
 *
 * Only well-known local locations named by the inventory policy are read,
 * and only names, one-line descriptions, versions, and transport types are
 * extracted. Server settings such as arguments, environment values, headers,
 * or URLs are never kept: the parsers look at key presence, not at values.
 * No network access is made.
 */
export const CAPABILITY_INVENTORY_SCHEMA_VERSION = "capability-inventory:v1";
export const INVENTORY_SOURCE_KINDS = Object.freeze(["skills", "commands", "plugins", "mcp-json", "mcp-toml"]);
export const INVENTORY_SOURCE_SCOPES = Object.freeze(["project", "user"]);
export const INVENTORY_TRANSPORTS = Object.freeze(["stdio", "http", "sse", "websocket", "unknown"]);

const SKILL_FILE_NAME = "SKILL.md";
const SOURCE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const ENTRY_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const ENV_REFERENCE_PATTERN = /\$\{([A-Z][A-Z0-9_]*)(?::-([^}]*))?\}/gu;
const TABLE_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/u;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/gu;
const SKIPPED_DIRECTORY_NAMES = new Set([".git", "node_modules"]);

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

/**
 * Built-in defaults. templates/sdlc-config.json carries the same values under
 * capability_discovery_policy.inventory so a project can adjust them; a
 * project whose configuration predates the setting falls back to these.
 */
export const DEFAULT_CAPABILITY_INVENTORY_POLICY = deepFreeze({
  enabled: true,
  limits: {
    max_entries: 500,
    max_directories: 500,
    max_depth: 4,
    max_frontmatter_bytes: 16384,
    max_config_bytes: 8388608,
    max_description_chars: 200,
  },
  matching: {
    max_suggestions: 5,
    min_tag_length: 3,
    ignored_tags: [
      "automation",
      "browser",
      "build",
      "compose",
      "config",
      "container",
      "core",
      "dependency",
      "file",
      "files",
      "framework",
      "infrastructure",
      "json",
      "language",
      "library",
      "npm",
      "package",
      "requirements",
      "runner",
      "script",
      "scripts",
      "test",
      "tool",
      "tools",
      "unreadable",
      "warning",
      "web",
    ],
    ambiguous_tags: ["go", "next"],
    aliases: {
      go: ["golang"],
      next: ["nextjs", "next js"],
      node: ["nodejs", "node js"],
      typescript: ["ts"],
    },
    exclude_names: ["agentic-sdlc"],
    phase_tags: {
      analysis: ["analysis", "architecture"],
      design: ["design", "architecture"],
      implementation: ["implementation"],
      validation: ["test", "testing", "review", "quality"],
      release: ["release", "deploy", "deployment"],
      operations: ["operations", "monitoring", "incident"],
    },
  },
  sources: [
    { id: "project-claude-skills", kind: "skills", scope: "project", path: ".claude/skills" },
    { id: "project-agents-skills", kind: "skills", scope: "project", path: ".agents/skills" },
    { id: "user-claude-skills", kind: "skills", scope: "user", path: "${CLAUDE_CONFIG_DIR:-~/.claude}/skills" },
    { id: "user-codex-skills", kind: "skills", scope: "user", path: "${CODEX_HOME:-~/.codex}/skills" },
    { id: "user-agents-skills", kind: "skills", scope: "user", path: "~/.agents/skills" },
    { id: "project-claude-commands", kind: "commands", scope: "project", path: ".claude/commands" },
    { id: "user-claude-commands", kind: "commands", scope: "user", path: "${CLAUDE_CONFIG_DIR:-~/.claude}/commands" },
    {
      id: "user-claude-plugins",
      kind: "plugins",
      scope: "user",
      path: "${CLAUDE_CONFIG_DIR:-~/.claude}/plugins/cache",
      manifests: [".claude-plugin/plugin.json", "plugin.json"],
      skills_dir: "skills",
      commands_dir: "commands",
    },
    {
      id: "user-codex-plugins",
      kind: "plugins",
      scope: "user",
      path: "${CODEX_HOME:-~/.codex}/plugins/cache",
      manifests: [".codex-plugin/plugin.json", "plugin.json"],
      skills_dir: "skills",
      commands_dir: "commands",
    },
    { id: "project-mcp-json", kind: "mcp-json", scope: "project", path: ".mcp.json", keys: [["mcpServers"]] },
    { id: "project-claude-settings", kind: "mcp-json", scope: "project", path: ".claude/settings.json", keys: [["mcpServers"]] },
    { id: "project-claude-local-settings", kind: "mcp-json", scope: "project", path: ".claude/settings.local.json", keys: [["mcpServers"]] },
    { id: "user-claude-settings", kind: "mcp-json", scope: "user", path: "${CLAUDE_CONFIG_DIR:-~/.claude}/settings.json", keys: [["mcpServers"]] },
    {
      id: "user-claude-json",
      kind: "mcp-json",
      scope: "user",
      path: "${CLAUDE_CONFIG_DIR:-~}/.claude.json",
      keys: [["mcpServers"], ["projects", "{project_root}", "mcpServers"]],
    },
    { id: "project-codex-config", kind: "mcp-toml", scope: "project", path: ".codex/config.toml", table: "mcp_servers" },
    { id: "user-codex-config", kind: "mcp-toml", scope: "user", path: "${CODEX_HOME:-~/.codex}/config.toml", table: "mcp_servers" },
  ],
});

// ---------------------------------------------------------------------------
// Policy

function policyIssue(label, message) {
  fail(`${label} ${message}`);
}

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function optionalPositiveInteger(value, fallback, label, maximum) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    policyIssue(label, `must be an integer between 1 and ${maximum}`);
  }
  return value;
}

function stringList(value, fallback, label, itemPattern = null) {
  if (value === undefined) return [...fallback];
  if (!Array.isArray(value)) policyIssue(label, "must be an array of strings");
  const seen = new Set();
  for (const [index, item] of value.entries()) {
    if (typeof item !== "string" || !item.trim()) policyIssue(`${label}[${index}]`, "must be a non-empty string");
    if (itemPattern && !itemPattern.test(item)) policyIssue(`${label}[${index}]`, "has an unsupported format");
    seen.add(item.trim());
  }
  return [...seen];
}

/** True for a project- or home-relative template that cannot leave its root by traversal. */
export function isSafeSourceTemplate(template) {
  if (typeof template !== "string" || !template.trim() || template.length > 512) return false;
  if (template.includes("\u0000") || template.includes("\\")) return false;
  if (template.startsWith("/")) return false;
  return !template.split("/").some((segment) => segment === "..");
}

function isSafeRelativeSegment(value) {
  return isSafeSourceTemplate(value) && !value.startsWith("~") && !value.startsWith("$");
}

function normalizeSource(raw, index) {
  const label = `capability_discovery_policy.inventory.sources[${index}]`;
  if (!plainObject(raw)) policyIssue(label, "must be an object");
  const known = new Set(["id", "kind", "scope", "path", "enabled", "manifests", "skills_dir", "commands_dir", "keys", "table"]);
  for (const key of Object.keys(raw)) {
    if (!known.has(key)) policyIssue(label, `has an unsupported property '${key}'`);
  }
  if (typeof raw.id !== "string" || !SOURCE_ID_PATTERN.test(raw.id)) {
    policyIssue(`${label}.id`, "must be a lower-case identifier");
  }
  if (!INVENTORY_SOURCE_KINDS.includes(raw.kind)) {
    policyIssue(`${label}.kind`, `must be one of ${INVENTORY_SOURCE_KINDS.join(", ")}`);
  }
  if (!INVENTORY_SOURCE_SCOPES.includes(raw.scope)) {
    policyIssue(`${label}.scope`, `must be one of ${INVENTORY_SOURCE_SCOPES.join(", ")}`);
  }
  if (!isSafeSourceTemplate(raw.path)) {
    policyIssue(`${label}.path`, "must be a project- or home-relative path without '..' segments");
  }
  if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") {
    policyIssue(`${label}.enabled`, "must be a boolean");
  }
  const source = { id: raw.id, kind: raw.kind, scope: raw.scope, path: raw.path, enabled: raw.enabled !== false };
  if (raw.kind === "plugins") {
    source.manifests = stringList(raw.manifests, [".claude-plugin/plugin.json", ".codex-plugin/plugin.json", "plugin.json"], `${label}.manifests`, null);
    for (const manifest of source.manifests) {
      if (!isSafeRelativeSegment(manifest)) policyIssue(`${label}.manifests`, "must hold safe relative file paths");
    }
    for (const field of ["skills_dir", "commands_dir"]) {
      const fallback = field === "skills_dir" ? "skills" : "commands";
      const value = raw[field] === undefined ? fallback : raw[field];
      if (!isSafeRelativeSegment(value)) policyIssue(`${label}.${field}`, "must be a safe relative directory");
      source[field] = value;
    }
  } else if (raw.kind === "mcp-json") {
    const keys = raw.keys === undefined ? [["mcpServers"]] : raw.keys;
    if (!Array.isArray(keys) || keys.length === 0 || keys.length > 8) policyIssue(`${label}.keys`, "must list between 1 and 8 key paths");
    source.keys = keys.map((keyPath, keyIndex) => {
      if (!Array.isArray(keyPath) || keyPath.length === 0 || keyPath.length > 6
        || keyPath.some((segment) => typeof segment !== "string" || !segment || segment.length > 512)) {
        policyIssue(`${label}.keys[${keyIndex}]`, "must be a short array of non-empty strings");
      }
      return [...keyPath];
    });
  } else if (raw.kind === "mcp-toml") {
    const table = raw.table === undefined ? "mcp_servers" : raw.table;
    if (typeof table !== "string" || !TABLE_NAME_PATTERN.test(table)) policyIssue(`${label}.table`, "must be a table name");
    source.table = table;
  }
  return source;
}

/**
 * Validate a (possibly partial) inventory policy and merge it with the
 * built-in defaults. Objects merge key by key; `sources` replaces the default
 * list when given, so a project controls exactly which locations are read.
 */
export function normalizeCapabilityInventoryPolicy(raw) {
  const defaults = DEFAULT_CAPABILITY_INVENTORY_POLICY;
  const label = "capability_discovery_policy.inventory";
  if (raw === undefined || raw === null) raw = {};
  if (!plainObject(raw)) policyIssue(label, "must be an object");
  for (const key of Object.keys(raw)) {
    if (!["enabled", "limits", "matching", "sources"].includes(key)) policyIssue(label, `has an unsupported property '${key}'`);
  }
  if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") policyIssue(`${label}.enabled`, "must be a boolean");
  const limitsInput = raw.limits === undefined ? {} : raw.limits;
  if (!plainObject(limitsInput)) policyIssue(`${label}.limits`, "must be an object");
  const limitMaximums = {
    max_entries: 5000,
    max_directories: 5000,
    max_depth: 8,
    max_frontmatter_bytes: 1048576,
    max_config_bytes: 67108864,
    max_description_chars: 1000,
  };
  const limits = {};
  for (const [key, maximum] of Object.entries(limitMaximums)) {
    limits[key] = optionalPositiveInteger(limitsInput[key], defaults.limits[key], `${label}.limits.${key}`, maximum);
  }
  for (const key of Object.keys(limitsInput)) {
    if (!(key in limitMaximums)) policyIssue(`${label}.limits`, `has an unsupported property '${key}'`);
  }

  const matchingInput = raw.matching === undefined ? {} : raw.matching;
  if (!plainObject(matchingInput)) policyIssue(`${label}.matching`, "must be an object");
  const aliasesInput = matchingInput.aliases === undefined ? defaults.matching.aliases : matchingInput.aliases;
  if (!plainObject(aliasesInput)) policyIssue(`${label}.matching.aliases`, "must be an object of string arrays");
  const aliases = {};
  for (const [tag, values] of Object.entries(aliasesInput)) {
    aliases[tag.toLowerCase()] = stringList(values, [], `${label}.matching.aliases.${tag}`);
  }
  const phaseInput = matchingInput.phase_tags === undefined ? defaults.matching.phase_tags : matchingInput.phase_tags;
  if (!plainObject(phaseInput)) policyIssue(`${label}.matching.phase_tags`, "must be an object of string arrays");
  const phaseTags = {};
  for (const [phase, values] of Object.entries(phaseInput)) {
    phaseTags[phase] = stringList(values, [], `${label}.matching.phase_tags.${phase}`);
  }
  const matching = {
    max_suggestions: optionalPositiveInteger(matchingInput.max_suggestions, defaults.matching.max_suggestions, `${label}.matching.max_suggestions`, 25),
    min_tag_length: optionalPositiveInteger(matchingInput.min_tag_length, defaults.matching.min_tag_length, `${label}.matching.min_tag_length`, 16),
    ignored_tags: stringList(matchingInput.ignored_tags, defaults.matching.ignored_tags, `${label}.matching.ignored_tags`).map((tag) => tag.toLowerCase()),
    ambiguous_tags: stringList(matchingInput.ambiguous_tags, defaults.matching.ambiguous_tags, `${label}.matching.ambiguous_tags`).map((tag) => tag.toLowerCase()),
    aliases,
    exclude_names: stringList(matchingInput.exclude_names, defaults.matching.exclude_names, `${label}.matching.exclude_names`),
    phase_tags: phaseTags,
  };
  for (const key of Object.keys(matchingInput)) {
    if (!(key in defaults.matching)) policyIssue(`${label}.matching`, `has an unsupported property '${key}'`);
  }

  const sourcesInput = raw.sources === undefined ? defaults.sources : raw.sources;
  if (!Array.isArray(sourcesInput) || sourcesInput.length > 64) policyIssue(`${label}.sources`, "must be an array of at most 64 sources");
  const sources = sourcesInput.map((source, index) => normalizeSource(source, index));
  const ids = new Set();
  for (const source of sources) {
    if (ids.has(source.id)) policyIssue(`${label}.sources`, `repeats the id '${source.id}'`);
    ids.add(source.id);
  }
  return { enabled: raw.enabled !== false, limits, matching, sources };
}

/** The inventory policy a project configuration asks for, merged with the defaults. */
export function capabilityInventoryPolicyFromConfig(config) {
  return normalizeCapabilityInventoryPolicy(config?.capability_discovery_policy?.inventory);
}

// ---------------------------------------------------------------------------
// Text parsing: names and one-line descriptions only

/** Collapse control characters and whitespace into one line, capped at maxChars. */
export function sanitizeInlineText(value, maxChars = 200) {
  const text = String(value ?? "").replace(CONTROL_CHARACTERS, " ").replace(/\s+/gu, " ").trim();
  if (!text) return null;
  const characters = Array.from(text);
  if (characters.length <= maxChars) return text;
  return `${characters.slice(0, Math.max(1, maxChars - 1)).join("").trimEnd()}…`;
}

function validEntryName(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return ENTRY_NAME_PATTERN.test(trimmed) ? trimmed : null;
}

function findClosingQuote(text, quote) {
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quote === "\"" && character === "\\") {
      index += 1;
    } else if (character === quote) {
      if (quote === "'" && text[index + 1] === "'") {
        index += 1;
      } else {
        return index;
      }
    }
  }
  return -1;
}

function decodeQuoted(text, quote) {
  if (quote === "'") return text.split("''").join("'");
  return text
    .replace(/\\n|\\t/gu, " ")
    .replace(/\\(.)/gu, "$1");
}

function readYamlScalar(lines, index, restRaw) {
  const rest = restRaw.trim();
  let next = index + 1;
  const continuation = () => {
    const collected = [];
    while (next < lines.length) {
      const candidate = lines[next];
      if (candidate.trim() === "") {
        collected.push("");
        next += 1;
      } else if (/^[ \t]/u.test(candidate)) {
        collected.push(candidate.trim());
        next += 1;
      } else {
        break;
      }
    }
    while (collected.length > 0 && collected[collected.length - 1] === "") collected.pop();
    return collected;
  };
  if (/^[|>][+-]?[0-9]*$/u.test(rest)) {
    return { value: continuation().join(" "), next };
  }
  if (rest === "") {
    const folded = continuation();
    if (folded.length === 0 || folded[0].startsWith("- ") || /^[A-Za-z_][A-Za-z0-9_-]*[ \t]*:/u.test(folded[0])) {
      return { value: null, next };
    }
    return { value: folded.join(" "), next };
  }
  const first = rest[0];
  if (first === "\"" || first === "'") {
    const parts = [];
    let buffer = rest.slice(1);
    for (;;) {
      const close = findClosingQuote(buffer, first);
      if (close >= 0) {
        parts.push(buffer.slice(0, close));
        break;
      }
      parts.push(buffer);
      if (next >= lines.length) break;
      buffer = lines[next].trim();
      next += 1;
    }
    return { value: decodeQuoted(parts.join(" "), first), next };
  }
  const plain = rest.replace(/\s+#.*$/u, "");
  return { value: [plain, ...continuation()].join(" "), next };
}

/**
 * Read the `name` and `description` keys of a YAML front-matter block. Only a
 * small, dependency-free subset is understood: plain, quoted, folded, and
 * literal scalars. Anything else under those keys is ignored.
 */
export function parseFrontmatter(text) {
  const lines = String(text ?? "").replace(/^﻿/u, "").split(/\r?\n/u);
  if (lines[0]?.trim() !== "---") return null;
  const fields = {};
  let index = 1;
  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();
    if (trimmed === "---" || trimmed === "...") break;
    const match = /^([A-Za-z_][A-Za-z0-9_-]*)[ \t]*:(.*)$/u.exec(line);
    if (!match) {
      index += 1;
      continue;
    }
    const scalar = readYamlScalar(lines, index, match[2]);
    index = scalar.next;
    if ((match[1] === "name" || match[1] === "description")
      && scalar.value !== null
      && !Object.hasOwn(fields, match[1])) {
      fields[match[1]] = scalar.value;
    }
  }
  return fields;
}

function skipBasicString(text, from) {
  let position = from;
  while (position < text.length) {
    if (text[position] === "\\") position += 2;
    else if (text[position] === "\"") return position + 1;
    else position += 1;
  }
  return text.length;
}

// Return the index of the last line that belongs to a TOML value starting on
// lines[startIndex]; multi-line arrays, inline tables, and multi-line strings
// are followed so their text is never mistaken for a table header.
function skipTomlValue(lines, startIndex, firstText) {
  let index = startIndex;
  let text = firstText;
  let depth = 0;
  let multiline = null;
  for (;;) {
    let position = 0;
    while (position < text.length) {
      if (multiline) {
        const end = text.indexOf(multiline, position);
        if (end < 0) {
          position = text.length;
        } else {
          position = end + 3;
          multiline = null;
        }
        continue;
      }
      const character = text[position];
      if (character === "#") {
        position = text.length;
      } else if (text.startsWith("\"\"\"", position) || text.startsWith("'''", position)) {
        multiline = text.slice(position, position + 3);
        position += 3;
      } else if (character === "\"") {
        position = skipBasicString(text, position + 1);
      } else if (character === "'") {
        const end = text.indexOf("'", position + 1);
        position = end < 0 ? text.length : end + 1;
      } else {
        if (character === "[" || character === "{") depth += 1;
        else if (character === "]" || character === "}") depth = Math.max(0, depth - 1);
        position += 1;
      }
    }
    if ((multiline || depth > 0) && index + 1 < lines.length) {
      index += 1;
      text = lines[index];
    } else {
      return index;
    }
  }
}

// Split the inside of a TOML table header into its key segments.
function parseTomlKeyPath(text) {
  const keys = [];
  let position = 0;
  while (position < text.length) {
    while (text[position] === " " || text[position] === "\t") position += 1;
    if (position >= text.length) return null;
    let key;
    if (text[position] === "\"") {
      const end = skipBasicString(text, position + 1);
      key = decodeQuoted(text.slice(position + 1, end - 1), "\"");
      position = end;
    } else if (text[position] === "'") {
      const end = text.indexOf("'", position + 1);
      if (end < 0) return null;
      key = text.slice(position + 1, end);
      position = end + 1;
    } else {
      const match = /^[A-Za-z0-9_-]+/u.exec(text.slice(position));
      if (!match) return null;
      key = match[0];
      position += key.length;
    }
    keys.push(key);
    while (text[position] === " " || text[position] === "\t") position += 1;
    if (position >= text.length) return keys;
    if (text[position] !== ".") return null;
    position += 1;
  }
  return null;
}

function parseTomlHeader(line) {
  let position = 1;
  let quote = null;
  while (position < line.length) {
    const character = line[position];
    if (quote) {
      if (quote === "\"" && character === "\\") position += 1;
      else if (character === quote) quote = null;
    } else if (character === "\"" || character === "'") {
      quote = character;
    } else if (character === "]") {
      return parseTomlKeyPath(line.slice(1, position));
    }
    position += 1;
  }
  return null;
}

export function normalizeTransport(value) {
  const text = String(value ?? "").trim().toLowerCase();
  if (text === "stdio") return "stdio";
  if (text === "http" || text === "streamable-http" || text === "streamable_http") return "http";
  if (text === "sse") return "sse";
  if (text === "ws" || text === "websocket") return "websocket";
  return "unknown";
}

function transportFromShape({ command, url, declared }) {
  const explicit = normalizeTransport(declared);
  if (explicit !== "unknown") return explicit;
  if (command) return "stdio";
  if (url) return "http";
  return "unknown";
}

/**
 * List the servers declared in `[<table>.<name>]` tables of a TOML document.
 * Only the server name, whether it runs a command or points at a URL, an
 * optional declared transport, and the enabled flag are read. Values are
 * skipped, so arguments, environment, and headers are never held.
 */
export function parseTomlMcpServers(text, table = "mcp_servers") {
  const servers = new Map();
  const lines = String(text ?? "").split(/\r?\n/u);
  let current = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("[[")) {
      current = null;
      continue;
    }
    if (line.startsWith("[")) {
      current = null;
      const keys = parseTomlHeader(line);
      const name = keys && keys.length === 2 && keys[0] === table ? validEntryName(keys[1]) : null;
      if (name) {
        if (!servers.has(name)) servers.set(name, { command: false, url: false, declared: null, enabled: true });
        current = servers.get(name);
      }
      continue;
    }
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    const valueText = line.slice(separator + 1);
    if (current) {
      if (key === "command") current.command = true;
      else if (key === "url") current.url = true;
      else if (key === "enabled") current.enabled = valueText.trim().replace(/#.*$/u, "").trim() !== "false";
      else if (key === "transport" || key === "type") {
        const declared = /^\s*["']([A-Za-z_-]{1,32})["']/u.exec(valueText);
        if (declared) current.declared = declared[1];
      }
    }
    index = skipTomlValue(lines, index, valueText);
  }
  return [...servers.entries()].map(([name, server]) => ({
    name,
    transport: transportFromShape(server),
    enabled: server.enabled,
  }));
}

function walkKeyPath(root, keyPath) {
  let node = root;
  for (const segment of keyPath) {
    if (!plainObject(node) || !Object.hasOwn(node, segment)) return null;
    node = node[segment];
  }
  return plainObject(node) ? node : null;
}

/**
 * List the servers under the given key paths of a JSON document. Only each
 * server's name, transport type, and disabled flag are read; every other
 * setting (command, arguments, environment, headers, URL) is ignored.
 */
export function parseMcpJsonServers(text, keyPaths = [["mcpServers"]], substitutions = {}) {
  let document;
  try {
    document = JSON.parse(String(text ?? ""));
  } catch {
    return null;
  }
  const servers = new Map();
  for (const keyPath of keyPaths) {
    const expansions = keyPath.some((segment) => segment === "{project_root}")
      ? [...new Set(substitutions.project_roots ?? [])].map((root) => keyPath.map((segment) => (segment === "{project_root}" ? root : segment)))
      : [keyPath];
    for (const expanded of expansions) {
      const node = walkKeyPath(document, expanded);
      if (!node) continue;
      for (const [rawName, configuration] of Object.entries(node)) {
        const name = validEntryName(rawName);
        if (!name || servers.has(name) || !plainObject(configuration)) continue;
        servers.set(name, {
          name,
          transport: transportFromShape({
            command: typeof configuration.command === "string",
            url: typeof configuration.url === "string",
            declared: typeof configuration.type === "string" ? configuration.type : configuration.transport,
          }),
          enabled: configuration.disabled !== true && configuration.enabled !== false,
        });
      }
    }
  }
  return [...servers.values()];
}

// ---------------------------------------------------------------------------
// Paths

function isInside(base, target) {
  const relative = path.relative(base, target);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function toPosix(value) {
  return value.split(path.sep).join("/");
}

/** A path as project-relative, `~`-relative, or a short external marker. */
export function displayInventoryPath(absolutePath, { projectRoot, home }) {
  const target = path.resolve(absolutePath);
  if (projectRoot && isInside(projectRoot, target)) {
    const relative = toPosix(path.relative(projectRoot, target));
    return relative || ".";
  }
  if (home && isInside(home, target)) {
    const relative = toPosix(path.relative(home, target));
    return relative ? `~/${relative}` : "~";
  }
  const segments = toPosix(target).split("/").filter(Boolean);
  return `(external)/${segments.slice(-3).join("/")}`;
}

function resolveSourceTemplate(template, { projectRoot, home, env }) {
  let missing = null;
  const expanded = template.replace(ENV_REFERENCE_PATTERN, (_match, name, fallback) => {
    const value = typeof env?.[name] === "string" ? env[name].trim() : "";
    if (value) return value;
    if (fallback !== undefined) return fallback;
    missing = name;
    return "";
  });
  if (missing) return { unset: missing };
  let target;
  if (expanded === "~" || expanded.startsWith("~/")) {
    if (!home) return { unset: "HOME" };
    target = path.join(home, expanded.slice(1));
  } else if (path.isAbsolute(expanded)) {
    target = expanded;
  } else {
    target = path.resolve(projectRoot, expanded);
  }
  return { absolute: path.normalize(target) };
}

function sortedNames(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function compareVersions(left, right) {
  const leftParts = String(left ?? "").split(/[.+-]/u);
  const rightParts = String(right ?? "").split(/[.+-]/u);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const a = leftParts[index] ?? "";
    const b = rightParts[index] ?? "";
    if (a === b) continue;
    const numeric = /^[0-9]+$/u.test(a) && /^[0-9]+$/u.test(b);
    if (numeric) return Number(a) < Number(b) ? -1 : 1;
    return sortedNames(a, b);
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Discovery

function safeHome() {
  try {
    const home = os.homedir();
    return typeof home === "string" && path.isAbsolute(home) ? path.resolve(home) : null;
  } catch {
    return null;
  }
}

function safeRealpath(target) {
  try {
    return fs.realpathSync(target);
  } catch {
    return null;
  }
}

function safeStat(target) {
  try {
    return fs.statSync(target);
  } catch {
    return null;
  }
}

function listDirectory(directory) {
  try {
    return fs.readdirSync(directory, { withFileTypes: true })
      .map((entry) => entry.name)
      .sort(sortedNames);
  } catch {
    return null;
  }
}

function isDirectory(target) {
  return safeStat(target)?.isDirectory() === true;
}

function readTextFile(target, maxBytes) {
  const stat = safeStat(target);
  if (!stat?.isFile()) return null;
  let descriptor = null;
  try {
    descriptor = fs.openSync(target, "r");
    const length = Math.min(stat.size, maxBytes);
    const buffer = Buffer.alloc(length);
    const read = length > 0 ? fs.readSync(descriptor, buffer, 0, length, 0) : 0;
    return { text: buffer.subarray(0, read).toString("utf8"), truncated: stat.size > maxBytes };
  } catch {
    return null;
  } finally {
    if (descriptor !== null) {
      try {
        fs.closeSync(descriptor);
      } catch {
        // The descriptor is already unusable; nothing else to release.
      }
    }
  }
}

function manifestDirectories(manifest, field, fallback) {
  const declared = manifest?.[field];
  const candidates = typeof declared === "string" ? [declared]
    : Array.isArray(declared) ? declared.filter((value) => typeof value === "string")
      : [];
  const safe = candidates
    .map((value) => value.replace(/^\.\//u, "").replace(/\/$/u, ""))
    .filter((value) => value && isSafeRelativeSegment(value));
  return safe.length > 0 ? safe : [fallback];
}

class InventoryRun {
  constructor(policy, { projectRoot, home, env }) {
    this.policy = policy;
    this.projectRoot = projectRoot;
    this.realProjectRoot = safeRealpath(projectRoot) ?? projectRoot;
    this.home = home;
    this.env = env;
    this.entries = 0;
    this.directories = 0;
    this.truncated = false;
    this.warnings = [];
    this.skills = [];
    this.commands = [];
    this.plugins = [];
    this.mcp = [];
  }

  show(absolutePath) {
    return displayInventoryPath(absolutePath, { projectRoot: this.projectRoot, home: this.home });
  }

  warn(message) {
    if (this.warnings.length < 50) this.warnings.push(message);
  }

  // A project-scoped location may not reach outside the project through links.
  allowed(source, target) {
    if (source.scope !== "project") return true;
    const real = safeRealpath(target);
    return real !== null && isInside(this.realProjectRoot, real);
  }

  take(list, entry) {
    if (this.entries >= this.policy.limits.max_entries) {
      this.truncated = true;
      return false;
    }
    this.entries += 1;
    list.push(entry);
    return true;
  }

  describe(text) {
    return sanitizeInlineText(text, this.policy.limits.max_description_chars);
  }

  readFrontmatter(file) {
    const content = readTextFile(file, this.policy.limits.max_frontmatter_bytes);
    return content ? parseFrontmatter(content.text) ?? {} : null;
  }

  collectSkills(source, directory, extra = {}) {
    const names = listDirectory(directory);
    let count = 0;
    for (const entryName of names ?? []) {
      const skillDirectory = path.join(directory, entryName);
      if (!isDirectory(skillDirectory) || !this.allowed(source, skillDirectory)) continue;
      const file = path.join(skillDirectory, SKILL_FILE_NAME);
      const meta = this.readFrontmatter(file);
      if (!meta) continue;
      const name = validEntryName(meta.name) ?? validEntryName(entryName);
      if (!name) continue;
      const entry = {
        type: "skill",
        name,
        description: this.describe(meta.description),
        scope: source.scope,
        source: source.id,
        plugin: extra.plugin ?? null,
        path: this.show(file),
      };
      if (!this.take(this.skills, entry)) break;
      count += 1;
    }
    return count;
  }

  collectCommands(source, directory, extra = {}) {
    const names = listDirectory(directory);
    let count = 0;
    for (const entryName of names ?? []) {
      if (!entryName.endsWith(".md")) continue;
      const file = path.join(directory, entryName);
      if (!this.allowed(source, file)) continue;
      const meta = this.readFrontmatter(file);
      if (!meta) continue;
      const name = validEntryName(entryName.slice(0, -3));
      if (!name) continue;
      const entry = {
        type: "command",
        name,
        description: this.describe(meta.description),
        scope: source.scope,
        source: source.id,
        plugin: extra.plugin ?? null,
        path: this.show(file),
      };
      if (!this.take(this.commands, entry)) break;
      count += 1;
    }
    return count;
  }

  findPluginRoots(source, root) {
    const found = [];
    const visit = (directory, depth) => {
      if (this.directories >= this.policy.limits.max_directories) {
        this.truncated = true;
        return;
      }
      this.directories += 1;
      for (const manifestPath of source.manifests) {
        const manifestFile = path.join(directory, manifestPath);
        const content = readTextFile(manifestFile, this.policy.limits.max_config_bytes);
        if (!content) continue;
        let manifest;
        try {
          manifest = JSON.parse(content.text);
        } catch {
          this.warn(`${source.id}: ignored an unreadable plugin manifest at ${this.show(manifestFile)}`);
          return;
        }
        const name = plainObject(manifest) ? validEntryName(manifest.name) : null;
        if (name) found.push({ directory, manifest, name });
        return;
      }
      if (depth >= this.policy.limits.max_depth) return;
      for (const childName of listDirectory(directory) ?? []) {
        if (SKIPPED_DIRECTORY_NAMES.has(childName)) continue;
        const child = path.join(directory, childName);
        let stat = null;
        try {
          stat = fs.lstatSync(child);
        } catch {
          stat = null;
        }
        if (stat?.isDirectory() && this.allowed(source, child)) visit(child, depth + 1);
      }
    };
    visit(root, 0);
    return found;
  }

  collectPlugins(source, root) {
    const candidates = this.findPluginRoots(source, root);
    // A cache keeps superseded versions; list only the newest of each plugin.
    const newest = new Map();
    for (const candidate of candidates) {
      const version = typeof candidate.manifest.version === "string" ? candidate.manifest.version : "";
      const current = newest.get(candidate.name);
      if (!current || compareVersions(version, current.version) > 0
        || (compareVersions(version, current.version) === 0 && candidate.directory < current.directory)) {
        newest.set(candidate.name, { ...candidate, version });
      }
    }
    let count = 0;
    for (const name of [...newest.keys()].sort(sortedNames)) {
      const plugin = newest.get(name);
      const skillDirectories = manifestDirectories(plugin.manifest, "skills", source.skills_dir);
      const commandDirectories = manifestDirectories(plugin.manifest, "commands", source.commands_dir);
      let skills = 0;
      let commands = 0;
      for (const relative of skillDirectories) {
        skills += this.collectSkills(source, path.join(plugin.directory, relative), { plugin: name });
      }
      for (const relative of commandDirectories) {
        commands += this.collectCommands(source, path.join(plugin.directory, relative), { plugin: name });
      }
      const entry = {
        type: "plugin",
        name,
        version: plugin.version || null,
        description: this.describe(plugin.manifest.description),
        scope: source.scope,
        source: source.id,
        skills,
        commands,
        path: this.show(plugin.directory),
      };
      if (!this.take(this.plugins, entry)) break;
      count += 1;
    }
    return count;
  }

  collectServers(source, servers) {
    let count = 0;
    for (const server of servers) {
      const entry = {
        type: "mcp",
        name: server.name,
        transport: server.transport,
        enabled: server.enabled,
        scope: source.scope,
        source: source.id,
        path: this.show(source.absolute),
      };
      if (!this.take(this.mcp, entry)) break;
      count += 1;
    }
    return count;
  }

  collectConfigServers(source) {
    const content = readTextFile(source.absolute, this.policy.limits.max_config_bytes);
    if (!content) return { status: "missing", entries: 0 };
    if (content.truncated) {
      this.warn(`${source.id}: skipped because the file is larger than the configured limit`);
      return { status: "skipped", entries: 0 };
    }
    let servers;
    if (source.kind === "mcp-toml") {
      servers = parseTomlMcpServers(content.text, source.table);
    } else {
      const roots = [this.projectRoot, this.realProjectRoot];
      servers = parseMcpJsonServers(content.text, source.keys, { project_roots: roots });
      if (servers === null) {
        this.warn(`${source.id}: could not be read as JSON`);
        return { status: "error", entries: 0 };
      }
    }
    return { status: "read", entries: this.collectServers(source, servers) };
  }

  collectSource(rawSource) {
    const source = { ...rawSource };
    const record = {
      id: source.id,
      kind: source.kind,
      scope: source.scope,
      path: source.path,
      status: "read",
      entries: 0,
    };
    if (!source.enabled) {
      record.status = "disabled";
      return record;
    }
    const resolved = resolveSourceTemplate(source.path, this);
    if (resolved.unset) {
      record.status = "unset";
      return record;
    }
    source.absolute = resolved.absolute;
    record.path = this.show(source.absolute);
    if (source.scope === "project" && !isInside(this.projectRoot, source.absolute)) {
      record.status = "skipped";
      this.warn(`${source.id}: skipped because a project location resolves outside the project`);
      return record;
    }
    if (!safeStat(source.absolute)) {
      record.status = "missing";
      return record;
    }
    if (!this.allowed(source, source.absolute)) {
      record.status = "skipped";
      this.warn(`${source.id}: skipped because it links outside the project`);
      return record;
    }
    try {
      if (source.kind === "skills") record.entries = this.collectSkills(source, source.absolute);
      else if (source.kind === "commands") record.entries = this.collectCommands(source, source.absolute);
      else if (source.kind === "plugins") record.entries = this.collectPlugins(source, source.absolute);
      else Object.assign(record, this.collectConfigServers(source));
    } catch {
      record.status = "error";
      this.warn(`${source.id}: could not be read`);
    }
    return record;
  }
}

/**
 * Discover installed skills, commands, plugins, and MCP servers.
 *
 * `policy` is the (possibly partial) capability_discovery_policy.inventory
 * value. `projectRoot`, `home`, and `env` default to the host's working
 * values and can be given to inspect another layout.
 */
export function collectCapabilityInventory({ projectRoot, policy, home, env } = {}) {
  const normalized = normalizeCapabilityInventoryPolicy(policy);
  const root = path.resolve(String(projectRoot ?? process.cwd()));
  const run = new InventoryRun(normalized, {
    projectRoot: root,
    home: home === undefined ? safeHome() : home,
    env: env ?? process.env,
  });
  const sources = normalized.enabled ? normalized.sources.map((source) => run.collectSource(source)) : [];
  return {
    schema_version: CAPABILITY_INVENTORY_SCHEMA_VERSION,
    enabled: normalized.enabled,
    counts: {
      skills: run.skills.length,
      commands: run.commands.length,
      plugins: run.plugins.length,
      mcp: run.mcp.length,
    },
    truncated: run.truncated,
    sources,
    plugins: run.plugins,
    skills: run.skills,
    commands: run.commands,
    mcp: run.mcp,
    warnings: run.warnings,
  };
}
