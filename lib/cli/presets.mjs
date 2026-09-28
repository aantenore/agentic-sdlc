import path from "node:path";
import { crypto, fs, process } from "../runtime/host.mjs";

const { createHash } = crypto;
const { readFileSync } = fs;

const PRESET_SCHEMA = "agentic-sdlc-cli-preset-v1";
const MAX_PRESET_BYTES = 64 * 1024;
const ALLOWED_OPTION_NAMES = new Set(["locale", "json", "full", "no-open"]);
const FORBIDDEN_PROPERTY_NAMES = new Set(["__proto__", "prototype", "constructor"]);

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

function stableStringify(value) {
  return JSON.stringify(stable(value), null, 2);
}

function digest(value) {
  return createHash("sha256").update(typeof value === "string" ? value : stableStringify(value), "utf8").digest("hex");
}

function preset(id, en, it, options) {
  return { id, description: { en, it }, options };
}

export const BUILTIN_CLI_PRESETS = deepFreeze({
  "human-en": preset(
    "human-en",
    "Human-readable English output.",
    "Output leggibile in inglese.",
    { locale: "en" },
  ),
  "human-it": preset(
    "human-it",
    "Human-readable Italian output.",
    "Output leggibile in italiano.",
    { locale: "it" },
  ),
  machine: preset(
    "machine",
    "Stable compact JSON for automation.",
    "JSON compatto e stabile per le automazioni.",
    { json: true },
  ),
  diagnostic: preset(
    "diagnostic",
    "Stable JSON with the available diagnostic detail.",
    "JSON stabile con i dettagli diagnostici disponibili.",
    { json: true, full: true },
  ),
  "no-browser": preset(
    "no-browser",
    "Keep local viewers from opening a browser window.",
    "Impedisce ai visualizzatori locali di aprire il browser.",
    { "no-open": true },
  ),
});

export class CliPresetError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "CliPresetError";
    this.code = code;
    this.details = deepFreeze({ ...details });
  }
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validateOption(name, value, source) {
  if (FORBIDDEN_PROPERTY_NAMES.has(name) || !ALLOWED_OPTION_NAMES.has(name)) {
    throw new CliPresetError(
      "UNSAFE_CLI_PRESET_OPTION",
      `Preset '${source}' cannot set '${name}'. Presets may set only: ${[...ALLOWED_OPTION_NAMES].sort().join(", ")}.`,
      { source, option: name, allowed_options: [...ALLOWED_OPTION_NAMES].sort() },
    );
  }
  if (["json", "full", "no-open"].includes(name) && typeof value !== "boolean") {
    throw new CliPresetError("INVALID_CLI_PRESET_VALUE", `Preset '${source}' option '${name}' must be true or false.`, { source, option: name });
  }
  if (name === "locale" && !["en", "it"].includes(value)) {
    throw new CliPresetError("INVALID_CLI_PRESET_VALUE", `Preset '${source}' option 'locale' must be en or it.`, { source, option: name });
  }
  return value;
}

function validateOptions(options, source) {
  if (!isPlainObject(options)) {
    throw new CliPresetError("INVALID_CLI_PRESET", `Preset '${source}' must contain a JSON object of options.`, { source });
  }
  const validated = Object.create(null);
  for (const [name, value] of Object.entries(options)) validated[name] = validateOption(name, value, source);
  return stable(validated);
}

function normalizeSpecs(rawPresets) {
  if (rawPresets === undefined || rawPresets === null) return [];
  const specs = Array.isArray(rawPresets) ? rawPresets : [rawPresets];
  return specs.map((value, index) => {
    if (typeof value !== "string" || !value.trim()) {
      throw new CliPresetError("INVALID_CLI_PRESET_REFERENCE", `CLI preset reference ${index + 1} must be a non-empty name or @file.json.`, { index });
    }
    return value.trim();
  });
}

function readPresetFile(reference, { cwd, readFile }) {
  const requested = reference.slice(1);
  if (!requested) {
    throw new CliPresetError("INVALID_CLI_PRESET_REFERENCE", "A file preset must use @file.json.");
  }
  const absolutePath = path.resolve(cwd, requested);
  let raw;
  try {
    raw = readFile(absolutePath);
  } catch (error) {
    throw new CliPresetError("CLI_PRESET_READ_FAILED", `Could not read preset file '${requested}': ${error.message}`, { reference });
  }
  const source = Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw);
  if (Buffer.byteLength(source, "utf8") > MAX_PRESET_BYTES) {
    throw new CliPresetError("CLI_PRESET_TOO_LARGE", `Preset file '${requested}' exceeds ${MAX_PRESET_BYTES} bytes.`, { reference });
  }
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw new CliPresetError("INVALID_CLI_PRESET_JSON", `Preset file '${requested}' is not valid JSON: ${error.message}`, { reference });
  }
  if (!isPlainObject(parsed)) {
    throw new CliPresetError("INVALID_CLI_PRESET", `Preset file '${requested}' must contain one JSON object.`, { reference });
  }

  const envelopeKeys = new Set(["schema_version", "name", "description", "options"]);
  const looksLikeEnvelope = Object.hasOwn(parsed, "options") || Object.hasOwn(parsed, "schema_version") || Object.hasOwn(parsed, "name");
  let options = parsed;
  if (looksLikeEnvelope) {
    for (const key of Object.keys(parsed)) {
      if (!envelopeKeys.has(key)) {
        throw new CliPresetError("INVALID_CLI_PRESET", `Preset file '${requested}' contains unsupported field '${key}'.`, { reference, field: key });
      }
    }
    if (parsed.schema_version !== undefined && parsed.schema_version !== PRESET_SCHEMA) {
      throw new CliPresetError("UNSUPPORTED_CLI_PRESET_SCHEMA", `Preset file '${requested}' uses unsupported schema '${parsed.schema_version}'.`, { reference });
    }
    if (parsed.name !== undefined && (typeof parsed.name !== "string" || !parsed.name.trim())) {
      throw new CliPresetError("INVALID_CLI_PRESET", `Preset file '${requested}' has an invalid name.`, { reference });
    }
    if (parsed.description !== undefined && typeof parsed.description !== "string") {
      throw new CliPresetError("INVALID_CLI_PRESET", `Preset file '${requested}' has an invalid description.`, { reference });
    }
    options = parsed.options;
  }
  const validatedOptions = validateOptions(options, `@${requested}`);
  const sha256 = digest(validatedOptions);
  return deepFreeze({
    id: `file:${sha256.slice(0, 12)}`,
    source: "file",
    sha256,
    options: validatedOptions,
  });
}

function resolveReference(reference, context) {
  if (reference.startsWith("@")) return readPresetFile(reference, context);
  const found = BUILTIN_CLI_PRESETS[reference];
  if (!found) {
    const suggestions = Object.keys(BUILTIN_CLI_PRESETS)
      .filter((id) => id.startsWith(reference[0] ?? ""))
      .slice(0, 3);
    const suffix = suggestions.length > 0 ? ` Did you mean ${suggestions.join(", ")}?` : "";
    throw new CliPresetError("UNKNOWN_CLI_PRESET", `Unknown CLI preset '${reference}'.${suffix}`, { reference, suggestions });
  }
  const options = validateOptions(found.options, found.id);
  return deepFreeze({
    id: found.id,
    source: "builtin",
    sha256: digest(options),
    options,
  });
}

function normalizeExplicitOptions(explicitOptions) {
  if (explicitOptions === undefined || explicitOptions === null) return {};
  if (!isPlainObject(explicitOptions)) throw new TypeError("explicitOptions must be an object");
  return { ...explicitOptions };
}

export function listCliPresets() {
  return deepFreeze(Object.values(BUILTIN_CLI_PRESETS)
    .map((entry) => ({
      id: entry.id,
      description: { ...entry.description },
      options: { ...entry.options },
      sha256: digest(entry.options),
    }))
    .sort((left, right) => left.id.localeCompare(right.id, "en")));
}

export function showCliPreset(id) {
  const normalized = String(id ?? "").trim();
  const entry = BUILTIN_CLI_PRESETS[normalized];
  if (!entry) throw new CliPresetError("UNKNOWN_CLI_PRESET", `Unknown CLI preset '${normalized}'.`, { id: normalized });
  return deepFreeze({
    schema_version: PRESET_SCHEMA,
    id: entry.id,
    description: { ...entry.description },
    options: { ...entry.options },
    sha256: digest(entry.options),
  });
}

export function resolveCliPresets(rawPresets, {
  cwd = process.cwd(),
  explicitOptions = {},
  readFile = readFileSync,
} = {}) {
  const specs = normalizeSpecs(rawPresets);
  const context = { cwd: path.resolve(String(cwd)), readFile };
  const applied = specs.map((reference) => resolveReference(reference, context));
  const presetOptions = Object.create(null);
  for (const entry of applied) Object.assign(presetOptions, entry.options);
  const explicit = normalizeExplicitOptions(explicitOptions);
  const options = { ...presetOptions, ...explicit };
  return deepFreeze({
    schema_version: PRESET_SCHEMA,
    applied: applied.map(({ id, source, sha256 }) => ({ id, source, sha256 })),
    preset_options: stable(presetOptions),
    explicit_option_names: Object.keys(explicit).sort(),
    options,
  });
}

export function exportCliPresets(rawPresets, {
  cwd = process.cwd(),
  readFile = readFileSync,
} = {}) {
  const resolved = resolveCliPresets(rawPresets, { cwd, readFile });
  return stableStringify({
    schema_version: PRESET_SCHEMA,
    options: resolved.preset_options,
  });
}

export const CLI_PRESET_ALLOWED_OPTIONS = deepFreeze([...ALLOWED_OPTION_NAMES].sort());
