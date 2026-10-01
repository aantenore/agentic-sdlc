import path from "node:path";
import { TextDecoder } from "node:util";

import { childProcess, crypto, fs, os, process } from "../runtime/host.mjs";
import { TarArchiveError, readTarGzipArchive } from "./tar-reader.mjs";

const { spawnSync } = childProcess;
const { createHash } = crypto;
const { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, realpathSync, rmSync, writeFileSync } = fs;


const POLICY_SCHEMA = "agentic-sdlc.release-artifact-policy.v1";
const REPORT_SCHEMA = "agentic-sdlc.release-artifact-verification.v1";
const SEMVER = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-((?:0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const COMMAND_TIMEOUT_MS = 60_000;
// An offline install of the packed archive is the slowest smoke step on
// Windows runners with older npm releases.
const INSTALL_TIMEOUT_MS = 180_000;
const COMMAND_OUTPUT_LIMIT = 4 * 1024 * 1024;
const MAX_JSON_NESTING_DEPTH = 64;
const NODE_BIN_SHEBANG_LF = Buffer.from("#!/usr/bin/env node\n", "utf8");
const NODE_BIN_SHEBANG_CRLF = Buffer.from("#!/usr/bin/env node\r\n", "utf8");


export class ReleaseArtifactError extends Error {
  constructor(code, message, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = "ReleaseArtifactError";
    this.code = code;
  }
}


function fail(code, message, cause) {
  throw new ReleaseArtifactError(code, message, cause);
}


function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}


function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}


export function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}


function skipWhitespace(state) {
  while (/\s/u.test(state.text[state.index] ?? "")) state.index += 1;
}


function scanJsonString(state) {
  if (state.text[state.index] !== '"') fail("INVALID_JSON", `${state.label} contains malformed JSON`);
  const start = state.index;
  state.index += 1;
  while (state.index < state.text.length) {
    const character = state.text[state.index];
    if (character === '"') {
      state.index += 1;
      try {
        return JSON.parse(state.text.slice(start, state.index));
      } catch (error) {
        fail("INVALID_JSON", `${state.label} contains an invalid JSON string`, error);
      }
    }
    if (character === "\\") {
      state.index += 2;
      continue;
    }
    state.index += 1;
  }
  fail("INVALID_JSON", `${state.label} contains an unterminated JSON string`);
}


function scanJsonValue(state, depth = 0) {
  if (depth > MAX_JSON_NESTING_DEPTH) {
    fail("JSON_NESTING_LIMIT_EXCEEDED", `${state.label} exceeds ${MAX_JSON_NESTING_DEPTH} nested containers`);
  }
  skipWhitespace(state);
  const character = state.text[state.index];
  if (character === "{") {
    state.index += 1;
    skipWhitespace(state);
    const keys = new Set();
    if (state.text[state.index] === "}") {
      state.index += 1;
      return;
    }
    while (state.index < state.text.length) {
      const key = scanJsonString(state);
      if (keys.has(key)) fail("DUPLICATE_JSON_KEY", `${state.label} contains duplicate key ${JSON.stringify(key)}`);
      keys.add(key);
      skipWhitespace(state);
      if (state.text[state.index] !== ":") fail("INVALID_JSON", `${state.label} contains malformed JSON`);
      state.index += 1;
      scanJsonValue(state, depth + 1);
      skipWhitespace(state);
      if (state.text[state.index] === "}") {
        state.index += 1;
        return;
      }
      if (state.text[state.index] !== ",") fail("INVALID_JSON", `${state.label} contains malformed JSON`);
      state.index += 1;
      skipWhitespace(state);
    }
  } else if (character === "[") {
    state.index += 1;
    skipWhitespace(state);
    if (state.text[state.index] === "]") {
      state.index += 1;
      return;
    }
    while (state.index < state.text.length) {
      scanJsonValue(state, depth + 1);
      skipWhitespace(state);
      if (state.text[state.index] === "]") {
        state.index += 1;
        return;
      }
      if (state.text[state.index] !== ",") fail("INVALID_JSON", `${state.label} contains malformed JSON`);
      state.index += 1;
    }
  } else if (character === '"') {
    scanJsonString(state);
    return;
  } else {
    const match = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/u.exec(state.text.slice(state.index));
    if (!match) fail("INVALID_JSON", `${state.label} contains malformed JSON`);
    state.index += match[0].length;
    return;
  }
  fail("INVALID_JSON", `${state.label} contains malformed JSON`);
}


export function parseStrictJson(bytes, label) {
  let text;
  try {
    text = UTF8_DECODER.decode(bytes);
  } catch (error) {
    fail("INVALID_JSON_UTF8", `${label} is not valid UTF-8`, error);
  }
  if (text.charCodeAt(0) === 0xfeff) fail("INVALID_JSON_BOM", `${label} must not contain a byte-order mark`);
  const state = { text, index: 0, label };
  scanJsonValue(state);
  skipWhitespace(state);
  if (state.index !== text.length) fail("INVALID_JSON", `${label} contains trailing data`);
  try {
    return JSON.parse(text);
  } catch (error) {
    fail("INVALID_JSON", `${label} is not valid JSON`, error);
  }
}


function assertPlainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    fail("INVALID_POLICY", `${label} must be a JSON object`);
  }
}


function assertExactKeys(value, allowed, required, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail("INVALID_POLICY", `${label} contains unsupported key ${key}`);
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) fail("INVALID_POLICY", `${label} is missing ${key}`);
  }
}


function validateRelativePolicyPath(value, label, { binTarget = false } = {}) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\\") || value.startsWith("/")) {
    fail("INVALID_POLICY", `${label} must be a non-empty POSIX relative path`);
  }
  let candidate = value;
  if (binTarget) {
    if (!candidate.startsWith("./")) fail("INVALID_POLICY", `${label} must start with ./`);
    candidate = candidate.slice(2);
  }
  const parts = candidate.split("/");
  if (parts.some((part) => !part || part === "." || part === "..") || /^[A-Za-z]:/u.test(candidate)) {
    fail("INVALID_POLICY", `${label} contains an unsafe component`);
  }
  return candidate;
}


export function validateReleaseArtifactPolicy(policy) {
  assertPlainObject(policy, "release policy");
  assertExactKeys(policy, ["$schema", "schema_version", "archive_limits", "package"], ["schema_version", "archive_limits", "package"], "release policy");
  if (policy.schema_version !== POLICY_SCHEMA) fail("INVALID_POLICY", `unsupported policy schema: ${policy.schema_version}`);

  assertPlainObject(policy.archive_limits, "archive_limits");
  const limitNames = [
    "max_compressed_bytes",
    "max_component_bytes",
    "max_entries",
    "max_file_bytes",
    "max_path_bytes",
    "max_pax_bytes",
    "max_total_file_bytes",
    "max_uncompressed_bytes",
  ];
  assertExactKeys(policy.archive_limits, limitNames, limitNames, "archive_limits");
  for (const name of limitNames) {
    if (!Number.isSafeInteger(policy.archive_limits[name]) || policy.archive_limits[name] <= 0) {
      fail("INVALID_POLICY", `archive_limits.${name} must be a positive safe integer`);
    }
  }
  if (policy.archive_limits.max_file_bytes > policy.archive_limits.max_total_file_bytes
      || policy.archive_limits.max_total_file_bytes > policy.archive_limits.max_uncompressed_bytes) {
    fail("INVALID_POLICY", "archive byte limits must increase from single file to total files to decompressed archive");
  }

  assertPlainObject(policy.package, "package policy");
  const packageKeys = [
    "name",
    "archive_root",
    "tag_prefix",
    "allowed_top_level",
    "required_files",
    "plugin_manifest",
    "installer",
    "bin",
    "forbidden_lifecycle_scripts",
  ];
  assertExactKeys(policy.package, packageKeys, packageKeys, "package policy");
  if (typeof policy.package.name !== "string" || !/^[a-z0-9][a-z0-9._-]*$/u.test(policy.package.name)) {
    fail("INVALID_POLICY", "package.name is invalid");
  }
  validateRelativePolicyPath(policy.package.archive_root, "package.archive_root");
  if (policy.package.archive_root.includes("/")) fail("INVALID_POLICY", "package.archive_root must be one path component");
  if (typeof policy.package.tag_prefix !== "string" || policy.package.tag_prefix.length > 8) {
    fail("INVALID_POLICY", "package.tag_prefix must be a short string");
  }

  for (const field of ["allowed_top_level", "required_files"]) {
    if (!Array.isArray(policy.package[field]) || policy.package[field].length === 0) {
      fail("INVALID_POLICY", `package.${field} must be a non-empty array`);
    }
    const unique = new Set();
    for (const value of policy.package[field]) {
      validateRelativePolicyPath(value, `package.${field}`);
      const folded = value.toLowerCase();
      if (unique.has(folded)) fail("INVALID_POLICY", `package.${field} contains a duplicate or case collision`);
      unique.add(folded);
    }
  }
  if (policy.package.allowed_top_level.some((value) => value.includes("/"))) {
    fail("INVALID_POLICY", "allowed_top_level entries must be one path component");
  }
  for (const required of policy.package.required_files) {
    if (!policy.package.allowed_top_level.includes(required.split("/", 1)[0])) {
      fail("INVALID_POLICY", `required file is outside allowed_top_level: ${required}`);
    }
  }
  validateRelativePolicyPath(policy.package.plugin_manifest, "package.plugin_manifest");
  validateRelativePolicyPath(policy.package.installer, "package.installer");
  if (!policy.package.required_files.includes(policy.package.plugin_manifest)
      || !policy.package.required_files.includes(policy.package.installer)
      || !policy.package.required_files.includes("package.json")) {
    fail("INVALID_POLICY", "required_files must include package.json, plugin_manifest, and installer");
  }

  assertPlainObject(policy.package.bin, "package.bin");
  if (Object.keys(policy.package.bin).length === 0) fail("INVALID_POLICY", "package.bin must not be empty");
  for (const [name, target] of Object.entries(policy.package.bin)) {
    if (!/^[a-z0-9][a-z0-9._-]*$/u.test(name)) fail("INVALID_POLICY", `invalid bin name: ${name}`);
    validateRelativePolicyPath(target, `package.bin.${name}`, { binTarget: true });
  }
  if (!Array.isArray(policy.package.forbidden_lifecycle_scripts)
      || policy.package.forbidden_lifecycle_scripts.length === 0) {
    fail("INVALID_POLICY", "package.forbidden_lifecycle_scripts must be a non-empty array");
  }
  const lifecycleScripts = new Set();
  for (const name of policy.package.forbidden_lifecycle_scripts) {
    if (typeof name !== "string" || !/^[A-Za-z][A-Za-z0-9:_-]*$/u.test(name)) {
      fail("INVALID_POLICY", "package.forbidden_lifecycle_scripts contains an invalid script name");
    }
    if (lifecycleScripts.has(name)) fail("INVALID_POLICY", `forbidden lifecycle script is duplicated: ${name}`);
    lifecycleScripts.add(name);
  }
  return policy;
}


export function loadReleaseArtifactPolicy(policyPath) {
  try {
    return validateReleaseArtifactPolicy(parseStrictJson(readFileSync(policyPath), "release policy"));
  } catch (error) {
    if (error instanceof ReleaseArtifactError) throw error;
    fail("POLICY_READ_FAILED", `could not read release policy: ${error.message}`, error);
  }
}


function archiveLimits(policy) {
  return {
    maxCompressedBytes: policy.archive_limits.max_compressed_bytes,
    maxComponentBytes: policy.archive_limits.max_component_bytes,
    maxEntries: policy.archive_limits.max_entries,
    maxFileBytes: policy.archive_limits.max_file_bytes,
    maxPathBytes: policy.archive_limits.max_path_bytes,
    maxPaxBytes: policy.archive_limits.max_pax_bytes,
    maxTotalFileBytes: policy.archive_limits.max_total_file_bytes,
    maxUncompressedBytes: policy.archive_limits.max_uncompressed_bytes,
  };
}


function assertPackageMetadata(value, label) {
  assertPlainObject(value, label);
  if (typeof value.name !== "string" || typeof value.version !== "string") {
    fail("INVALID_PACKAGE_METADATA", `${label} must declare string name and version fields`);
  }
}


function verifyArchiveMetadata(archive, policy, expectedTag) {
  if (typeof expectedTag !== "string" || expectedTag.length === 0) {
    fail("EXPECTED_TAG_REQUIRED", "expected release tag is required");
  }
  const root = policy.package.archive_root;
  const prefix = `${root}/`;
  const files = new Map();
  const topLevel = new Set();
  for (const entry of archive.entries) {
    if ((entry.mode & 0o7022) !== 0) {
      fail("UNSAFE_FILE_MODE", `archive entry has unsafe permission bits: ${entry.path}`);
    }
    if (entry.path === root && entry.type === "directory") continue;
    if (!entry.path.startsWith(prefix)) fail("ARCHIVE_ROOT_MISMATCH", `archive entry is outside ${root}/: ${entry.path}`);
    const relative = entry.path.slice(prefix.length);
    const first = relative.split("/", 1)[0];
    if (!policy.package.allowed_top_level.includes(first)) {
      fail("TOP_LEVEL_NOT_ALLOWED", `package top-level path is not allowed: ${first}`);
    }
    topLevel.add(first);
    if (entry.type === "file") files.set(relative, entry);
  }
  for (const required of policy.package.required_files) {
    if (!files.has(required)) fail("REQUIRED_FILE_MISSING", `required package file is missing: ${required}`);
  }

  const packageJson = parseStrictJson(files.get("package.json").data, "package/package.json");
  const pluginJson = parseStrictJson(files.get(policy.package.plugin_manifest).data, `package/${policy.package.plugin_manifest}`);
  assertPackageMetadata(packageJson, "package/package.json");
  assertPackageMetadata(pluginJson, `package/${policy.package.plugin_manifest}`);
  if (packageJson.name !== policy.package.name || pluginJson.name !== policy.package.name) {
    fail("PACKAGE_NAME_MISMATCH", "package and plugin names must match release policy");
  }
  if (!SEMVER.test(packageJson.version)) fail("INVALID_PACKAGE_VERSION", `package version is not strict SemVer: ${packageJson.version}`);
  if (pluginJson.version !== packageJson.version) fail("VERSION_MISMATCH", "package and plugin versions do not match");
  const requiredTag = `${policy.package.tag_prefix}${packageJson.version}`;
  if (expectedTag !== requiredTag) fail("TAG_VERSION_MISMATCH", `release tag must be ${requiredTag}`);

  if (canonicalJson(packageJson.bin) !== canonicalJson(policy.package.bin)) {
    fail("BIN_CONTRACT_MISMATCH", "package bin declaration does not match release policy");
  }
  if (packageJson.scripts !== undefined) {
    if (!packageJson.scripts || typeof packageJson.scripts !== "object" || Array.isArray(packageJson.scripts)) {
      fail("INVALID_PACKAGE_METADATA", "package scripts must be a JSON object when present");
    }
    for (const name of policy.package.forbidden_lifecycle_scripts) {
      if (Object.hasOwn(packageJson.scripts, name)) {
        fail("UNSAFE_LIFECYCLE_SCRIPT", `package declares forbidden npm lifecycle script: ${name}`);
      }
    }
  }
  for (const target of Object.values(policy.package.bin)) {
    const relative = target.slice(2);
    const binEntry = files.get(relative);
    if (!binEntry) fail("BIN_TARGET_MISSING", `package bin target is missing: ${relative}`);
    const isWindowsPackMode = binEntry.mode === 0o644;
    const hasOwnerRwx = (binEntry.mode & 0o700) === 0o700;
    if (!isWindowsPackMode && !hasOwnerRwx) {
      fail("BIN_TARGET_MODE_NOT_PORTABLE", `package bin target must grant its owner read, write, and execute permissions or use npm's portable 0644 mode: ${relative}`);
    }
    const hasLfShebang = binEntry.data
      .subarray(0, NODE_BIN_SHEBANG_LF.length)
      .equals(NODE_BIN_SHEBANG_LF);
    const hasCrlfShebang = binEntry.data
      .subarray(0, NODE_BIN_SHEBANG_CRLF.length)
      .equals(NODE_BIN_SHEBANG_CRLF);
    if (!hasLfShebang && !hasCrlfShebang) {
      fail("BIN_TARGET_INVALID_SHEBANG", `package bin target must start with #!/usr/bin/env node followed by LF or CRLF: ${relative}`);
    }
  }

  const fileRecords = [...files.entries()]
    .map(([relative, entry]) => ({ path: relative, sha256: sha256(entry.data), size: entry.size }))
    .sort((left, right) => compareText(left.path, right.path));
  return {
    fileRecords,
    packageJson,
    pluginJson,
    snapshotSha256: sha256(canonicalJson(fileRecords)),
    topLevel: [...topLevel].sort(compareText),
  };
}


export function resolveExecutablePath(command, { environment = process.env } = {}) {
  const resolveRegularFile = (candidate) => {
    try {
      const resolved = realpathSync(candidate);
      return lstatSync(resolved).isFile() ? resolved : null;
    } catch {
      return null;
    }
  };
  if (typeof command !== "string" || command.length === 0) {
    fail("COMMAND_NOT_FOUND", "required command was not specified");
  }
  if (path.isAbsolute(command) || command.includes(path.sep) || (path.sep === "\\" && command.includes("/"))) {
    const resolved = resolveRegularFile(command);
    if (!resolved) fail("COMMAND_NOT_FOUND", `required command was not found: ${command}`);
    return resolved;
  }
  const extensions = process.platform === "win32"
    ? (environment.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";")
    : [""];
  for (const directory of (environment.PATH ?? "").split(path.delimiter)) {
    if (!directory) continue;
    for (const extension of extensions) {
      const candidate = path.join(directory, `${command}${extension}`);
      const resolved = resolveRegularFile(candidate);
      if (resolved) return resolved;
    }
  }
  fail("COMMAND_NOT_FOUND", `required command was not found: ${command}`);
}


export function npmCliCandidates({
  configured,
  nodeExecutable = process.execPath,
  npmExecPath = process.env.npm_execpath,
  platform = process.platform,
} = {}) {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const candidates = [configured, npmExecPath];
  if (platform === "win32") {
    candidates.push(pathApi.join(pathApi.dirname(nodeExecutable), "node_modules", "npm", "bin", "npm-cli.js"));
  } else {
    candidates.push(pathApi.resolve(pathApi.dirname(nodeExecutable), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"));
  }
  return candidates.filter(Boolean);
}


function resolveNpmCli(configured) {
  const candidates = npmCliCandidates({ configured });
  try {
    candidates.push(resolveExecutablePath(process.platform === "win32" ? "npm.cmd" : "npm"));
  } catch (error) {
    if (!(error instanceof ReleaseArtifactError) || error.code !== "COMMAND_NOT_FOUND") throw error;
  }
  for (const candidate of candidates) {
    if (!candidate || !existsSync(candidate)) continue;
    const resolved = realpathSync(candidate);
    if (resolved.endsWith(".js") && lstatSync(resolved).isFile()) return resolved;
  }
  fail("NPM_CLI_NOT_FOUND", "npm CLI could not be resolved; pass --npm-cli explicitly");
}


function safeCommandPath() {
  const directories = [path.dirname(process.execPath)];
  if (process.platform === "win32") {
    if (process.env.SystemRoot) directories.push(path.join(process.env.SystemRoot, "System32"));
  } else {
    directories.push("/usr/bin", "/bin", "/usr/sbin", "/sbin");
  }
  return [...new Set(directories)].join(path.delimiter);
}


function smokeEnvironment(home, npmCache) {
  const inherited = {};
  const safeInheritedKeys = new Set([
    "comspec",
    "lang",
    "lc_all",
    "pathext",
    "systemroot",
    "windir",
  ]);
  for (const [key, value] of Object.entries(process.env)) {
    if (safeInheritedKeys.has(key.toLowerCase())) inherited[key] = value;
  }
  const temporary = path.dirname(home);
  return {
    ...inherited,
    CI: "1",
    HOME: home,
    USERPROFILE: home,
    XDG_CACHE_HOME: path.join(home, ".cache"),
    XDG_CONFIG_HOME: path.join(home, ".config"),
    USER: "release-verifier",
    USERNAME: "release-verifier",
    LOGNAME: "release-verifier",
    NODE_OPTIONS: "",
    NO_UPDATE_NOTIFIER: "1",
    PATH: safeCommandPath(),
    TEMP: temporary,
    TMP: temporary,
    TMPDIR: temporary,
    PYTHONIOENCODING: "utf-8",
    PYTHONDONTWRITEBYTECODE: "1",
    npm_config_audit: "false",
    npm_config_cache: npmCache,
    npm_config_fund: "false",
    npm_config_ignore_scripts: "true",
    npm_config_offline: "true",
    npm_config_proxy: "",
    npm_config_https_proxy: "",
    npm_config_registry: "https://registry.invalid/",
    npm_config_update_notifier: "false",
    npm_config_userconfig: path.join(home, ".npmrc-does-not-exist"),
  };
}


function runCommand(executable, args, options, label) {
  const result = spawnSync(executable, args, {
    cwd: options.cwd,
    encoding: "utf8",
    env: options.env,
    maxBuffer: COMMAND_OUTPUT_LIMIT,
    shell: false,
    timeout: options.timeout ?? COMMAND_TIMEOUT_MS,
  });
  if (result.error) fail("SMOKE_COMMAND_FAILED", `${label} could not run: ${result.error.message}`, result.error);
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim().slice(0, 800);
    fail("SMOKE_COMMAND_FAILED", `${label} failed with exit code ${result.status}${detail ? `: ${detail}` : ""}`);
  }
  if (Buffer.byteLength(result.stdout ?? "") > COMMAND_OUTPUT_LIMIT
      || Buffer.byteLength(result.stderr ?? "") > COMMAND_OUTPUT_LIMIT) {
    fail("SMOKE_OUTPUT_LIMIT_EXCEEDED", `${label} produced too much output`);
  }
  return result;
}


function snapshotTree(root) {
  if (!existsSync(root)) return { exists: false, sha256: sha256("[]") };
  const records = [];
  const boundary = realpathSync(root);
  const visit = (current, relative) => {
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) {
      const target = readlinkSync(current);
      let resolved;
      try {
        resolved = realpathSync(current);
      } catch (error) {
        fail("SMOKE_TREE_LINK_INVALID", `isolated verification tree contains a broken link: ${relative}`, error);
      }
      if (resolved !== boundary && !resolved.startsWith(`${boundary}${path.sep}`)) {
        fail("SMOKE_TREE_LINK_ESCAPE", `isolated verification tree contains an escaping link: ${relative}`);
      }
      records.push({ path: relative, type: "symlink", target });
      return;
    }
    if (stat.isDirectory()) {
      records.push({ path: relative || ".", type: "directory" });
      for (const name of readdirSync(current).sort(compareText)) {
        visit(path.join(current, name), relative ? `${relative}/${name}` : name);
      }
      return;
    }
    if (!stat.isFile()) fail("SMOKE_HOME_SPECIAL_FILE", `smoke HOME contains a special file: ${relative}`);
    records.push({ path: relative, type: "file", size: stat.size, sha256: sha256(readFileSync(current)) });
  };
  visit(root, "");
  return { exists: true, sha256: sha256(canonicalJson(records)) };
}


export function proveNoTreeWrites(root, operation) {
  const before = snapshotTree(root);
  let result;
  let operationError;
  try {
    result = operation();
  } catch (error) {
    operationError = error;
  }
  const after = snapshotTree(root);
  if (canonicalJson(before) !== canonicalJson(after)) {
    fail("READ_ONLY_OPERATION_WROTE_FILES", "read-only operation changed the isolated verification tree", operationError);
  }
  if (operationError) throw operationError;
  return result;
}


export function summarizeDoctorChecks(checks) {
  if (!Array.isArray(checks) || checks.length > 256) {
    fail("DOCTOR_OUTPUT_INVALID", "doctor checks must be an array with at most 256 entries");
  }
  const identifiers = new Set();
  return checks.map((check) => {
    if (!check || typeof check !== "object" || Array.isArray(check)) {
      fail("DOCTOR_OUTPUT_INVALID", "every doctor check must be an object");
    }
    for (const field of ["id", "status"]) {
      const value = check[field];
      if (typeof value !== "string"
          || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value)
          || Buffer.byteLength(value, "utf8") > 128) {
        fail("DOCTOR_OUTPUT_INVALID", `doctor check ${field} must be a bounded portable string`);
      }
    }
    if (identifiers.has(check.id)) fail("DOCTOR_OUTPUT_INVALID", `doctor check id is duplicated: ${check.id}`);
    identifiers.add(check.id);
    return { id: check.id, status: check.status };
  }).sort((left, right) => compareText(left.id, right.id));
}


function runInstalledPackageSmoke({ archiveBytes, npmCliPath, packageBins, packageName, pythonExecutable }) {
  const temporary = mkdtempSync(path.join(os.tmpdir(), "agentic-sdlc-release-verify-"));
  try {
    const trustedArchive = path.join(temporary, "verified-package.tgz");
    const installRoot = path.join(temporary, "install");
    const npmCache = path.join(temporary, "npm-cache");
    const smokeHome = path.join(temporary, "home");
    const doctorRoot = path.join(temporary, "project");
    mkdirSync(installRoot, { recursive: true });
    mkdirSync(npmCache, { recursive: true });
    mkdirSync(doctorRoot, { recursive: true });
    writeFileSync(trustedArchive, archiveBytes, { flag: "wx", mode: 0o600 });

    const environment = smokeEnvironment(smokeHome, npmCache);
    const npmCli = resolveNpmCli(npmCliPath);
    runCommand(process.execPath, [
      npmCli,
      "install",
      "--offline",
      "--ignore-scripts",
      "--bin-links=true",
      "--no-audit",
      "--no-fund",
      "--package-lock=false",
      "--loglevel=error",
      "--prefix",
      installRoot,
      trustedArchive,
    ], { cwd: installRoot, env: environment, timeout: INSTALL_TIMEOUT_MS }, "offline npm install");

    const installedRoot = path.join(installRoot, "node_modules", packageName);
    const installedBins = Object.entries(packageBins)
      .sort(([left], [right]) => compareText(left, right))
      .map(([name, target]) => ({
        name,
        path: path.join(installedRoot, ...target.slice(2).split("/")),
      }));
    for (const installedBin of installedBins) {
      if (!existsSync(installedBin.path) || !lstatSync(installedBin.path).isFile()) {
        fail("INSTALLED_BIN_MISSING", `installed package does not contain CLI entry point ${installedBin.name}`);
      }
      const installedBytes = readFileSync(installedBin.path);
      if (!installedBytes.subarray(0, NODE_BIN_SHEBANG_LF.length).equals(NODE_BIN_SHEBANG_LF)) {
        fail("INSTALLED_BIN_INVALID_SHEBANG", `npm did not install an LF-terminated Node shebang for ${installedBin.name}`);
      }
      if (process.platform === "win32") {
        const shim = path.join(installRoot, "node_modules", ".bin", `${installedBin.name}.cmd`);
        if (!existsSync(shim) || !lstatSync(shim).isFile()) {
          fail("INSTALLED_BIN_SHIM_MISSING", `npm did not create the Windows command shim for ${installedBin.name}`);
        }
      } else if ((lstatSync(installedBin.path).mode & 0o700) !== 0o700) {
        fail("INSTALLED_BIN_NOT_EXECUTABLE", `npm did not grant the owner read, write, and execute permissions for ${installedBin.name}`);
      }
    }
    const primaryBin = installedBins[0];
    const helpExecutable = process.platform === "win32" ? process.execPath : primaryBin.path;
    const helpArguments = process.platform === "win32" ? [primaryBin.path, "--help"] : ["--help"];
    runCommand(helpExecutable, helpArguments, { cwd: installRoot, env: environment }, "installed CLI help");
    const doctor = runCommand(
      process.execPath,
      [primaryBin.path, "doctor", "--root", doctorRoot, "--json"],
      { cwd: installRoot, env: environment },
      "installed CLI doctor",
    );
    const doctorPayload = parseStrictJson(Buffer.from(doctor.stdout), "doctor JSON output");
    if (doctorPayload?.status !== "passed" || !Array.isArray(doctorPayload.checks)) {
      fail("DOCTOR_FAILED", "installed CLI doctor did not report passed checks");
    }

    const python = resolveExecutablePath(pythonExecutable || process.env.PYTHON || (process.platform === "win32" ? "python" : "python3"));
    const installer = path.join(installedRoot, "scripts", "install-personal-marketplace.py");
    const planPayload = proveNoTreeWrites(temporary, () => {
      const plan = runCommand(
        python,
        [installer, "plan", "--json", "--home", smokeHome],
        { cwd: installedRoot, env: environment },
        "read-only installer plan",
      );
      return parseStrictJson(Buffer.from(plan.stdout), "installer plan JSON output");
    });
    if (planPayload?.ok !== true || planPayload.command !== "plan" || planPayload.schema !== "agentic-sdlc.local-installer.v1") {
      fail("INSTALLER_PLAN_FAILED", "installer plan did not return its read-only success contract");
    }

    const installerV2 = path.join(installedRoot, "scripts", "install-personal-marketplace-v2.py");
    const v2PlanPayload = proveNoTreeWrites(temporary, () => {
      const plan = runCommand(
        python,
        [installerV2, "plan", "--json", "--home", smokeHome],
        { cwd: installedRoot, env: environment },
        "read-only installer v2 plan",
      );
      return parseStrictJson(Buffer.from(plan.stdout), "installer v2 plan JSON output");
    });
    if (v2PlanPayload?.ok !== true
        || v2PlanPayload.command !== "plan"
        || v2PlanPayload.schema !== "agentic-sdlc.local-installer.v2") {
      fail("INSTALLER_V2_PLAN_FAILED", "installer v2 plan did not return its read-only success contract");
    }

    const doctorChecks = summarizeDoctorChecks(doctorPayload.checks);
    return {
      npm_install: "passed",
      cli_help: "passed",
      doctor: "passed",
      doctor_checks: doctorChecks,
      installer_plan: "passed",
      installer_zero_write: true,
      installer_v2_plan: "passed",
      installer_v2_zero_write: true,
    };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}


export function verifyReleaseArtifact({
  artifactPath,
  expectedTag,
  policyPath,
  npmCliPath,
  pythonExecutable,
  smoke = true,
}) {
  if (!artifactPath) fail("ARTIFACT_REQUIRED", "release archive path is required");
  if (!policyPath) fail("POLICY_REQUIRED", "release policy path is required");
  const policy = loadReleaseArtifactPolicy(policyPath);
  let archive;
  try {
    archive = readTarGzipArchive(artifactPath, archiveLimits(policy));
  } catch (error) {
    if (error instanceof TarArchiveError) fail(error.code, error.message, error);
    throw error;
  }
  const metadata = verifyArchiveMetadata(archive, policy, expectedTag);
  const smokeReport = smoke
    ? runInstalledPackageSmoke({
      archiveBytes: archive.archiveBytes,
      npmCliPath,
      packageBins: policy.package.bin,
      packageName: policy.package.name,
      pythonExecutable,
    })
    : {
      npm_install: "not_run",
      cli_help: "not_run",
      doctor: "not_run",
      doctor_checks: [],
      installer_plan: "not_run",
      installer_zero_write: false,
      installer_v2_plan: "not_run",
      installer_v2_zero_write: false,
    };

  return {
    schema_version: REPORT_SCHEMA,
    status: "passed",
    artifact: {
      sha256: sha256(archive.archiveBytes),
      compressed_bytes: archive.archiveBytes.length,
      snapshot_sha256: metadata.snapshotSha256,
    },
    archive: {
      file_count: metadata.fileRecords.length,
      header_count: archive.headerCount,
      total_file_bytes: archive.totalFileBytes,
      uncompressed_bytes: archive.uncompressedBytes,
      top_level: metadata.topLevel,
    },
    package: {
      name: metadata.packageJson.name,
      version: metadata.packageJson.version,
      tag: expectedTag,
      bin: metadata.packageJson.bin,
    },
    checks: [
      { id: "archive-structure", status: "passed" },
      { id: "package-allowlist", status: "passed" },
      { id: "metadata-consistency", status: "passed" },
      { id: "package-smoke", status: smoke ? "passed" : "not_run" },
    ],
    smoke: smokeReport,
  };
}
