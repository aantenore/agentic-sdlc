import path from "node:path";
import { promisify } from "node:util";

import { childProcess, fs, process } from "./runtime/host.mjs";
import {
  computeStableHash,
  DomainValidationError,
  immutableJson,
  requireNonEmptyString,
  requirePlainRecord,
} from "./canonical.mjs";

const { execFile: execFileCallback } = childProcess;

export const RTK_ADAPTER_ID = "rtk";
export const RTK_GAIN_CONTRACT = "rtk-gain:v0.43+";
export const RTK_MINIMUM_VERSION = "0.43.0";
export const RTK_SAVINGS_CLASSIFICATION = "estimated";
export const RTK_ENFORCEMENT_CLASSIFICATION = "advisory";

const DEFAULT_EXECUTABLE = "rtk";
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
const SAFE_TEXT_PATTERN = /^[^\u0000-\u001f\u007f]+$/u;
const SUPPORTED_PROFILES = new Set(["auto", "native", "test", "git", "rg"]);
const SAFE_GIT_SUBCOMMANDS = new Set(["status", "diff", "log", "show", "shortlog"]);
const SAFE_GATEWAY_EXECUTABLES = new Set(["npm", "pnpm", "yarn", "bun", "node", "pytest", "jest", "vitest", "git", "rg"]);
const WINDOWS_NODE_SHIM_EXECUTABLES = new Set(["npm", "pnpm", "yarn", "jest", "vitest"]);
const WINDOWS_NATIVE_EXECUTABLE_EXTENSIONS = new Set([".exe", ".com"]);
const WINDOWS_NODE_SHIM_EXTENSIONS = new Set([".cmd", ".bat"]);
const WINDOWS_SAFE_PATHEXT = new Set([
  ...WINDOWS_NATIVE_EXECUTABLE_EXTENSIONS,
  ...WINDOWS_NODE_SHIM_EXTENSIONS,
]);
const DEFAULT_WINDOWS_PATHEXT = Object.freeze([".com", ".exe", ".bat", ".cmd"]);
const MAX_WINDOWS_SHIM_BYTES = 64 * 1024;
const execFile = promisify(execFileCallback);

export class RtkExecutionError extends Error {
  constructor(message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = "RtkExecutionError";
    this.code = options.code || "rtk_execution_failed";
    this.exit_code = options.exit_code ?? null;
    this.stderr = options.stderr || "";
  }
}

export function parseRtkVersion(output, minimumVersion = RTK_MINIMUM_VERSION) {
  const raw = normalizeSafeText(output, "rtk_version_output", 512);
  const match = raw.match(/^rtk\s+v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/iu);
  if (!match) {
    throw new DomainValidationError("RTK version output does not match the expected 'rtk <semver>' identity");
  }
  const coreVersion = `${Number(match[1])}.${Number(match[2])}.${Number(match[3])}`;
  const prerelease = match[4] || null;
  const version = `${coreVersion}${prerelease ? `-${prerelease}` : ""}`;
  const minimum = effectiveMinimumVersion(minimumVersion);
  const current = parseSemanticVersion(coreVersion, "rtk_version");
  const comparison = compareSemanticVersions(current, minimum);
  const supported = comparison > 0 || (comparison === 0 && prerelease === null);
  return immutableJson({
    version,
    major: current.major,
    minor: current.minor,
    patch: current.patch,
    minimum_version: minimum.version,
    supported,
    gain_contract: supported ? RTK_GAIN_CONTRACT : null,
  });
}

export function buildRtkGainArgv() {
  return Object.freeze(["gain", "--project", "--format", "json"]);
}

export function normalizeRtkGainReport(value) {
  requirePlainRecord(value, "rtk_gain_report");
  const summary = requirePlainRecord(value.summary, "rtk_gain_report.summary");
  const totalCommands = normalizeNonNegativeInteger(summary.total_commands, "rtk_gain_report.summary.total_commands");
  const totalInput = normalizeNonNegativeInteger(summary.total_input, "rtk_gain_report.summary.total_input");
  const totalOutput = normalizeNonNegativeInteger(summary.total_output, "rtk_gain_report.summary.total_output");
  const totalSaved = normalizeNonNegativeInteger(summary.total_saved, "rtk_gain_report.summary.total_saved");
  const savingsPercent = normalizePercentage(summary.avg_savings_pct, "rtk_gain_report.summary.avg_savings_pct");
  const totalTimeMs = normalizeOptionalNonNegativeNumber(summary.total_time_ms, "rtk_gain_report.summary.total_time_ms");
  const averageTimeMs = normalizeOptionalNonNegativeNumber(summary.avg_time_ms, "rtk_gain_report.summary.avg_time_ms");
  return immutableJson({
    total_commands: totalCommands,
    estimated_input_tokens: totalInput,
    estimated_output_tokens: totalOutput,
    estimated_tokens_avoided: totalSaved,
    estimated_savings_percent: savingsPercent,
    total_time_ms: totalTimeMs,
    average_time_ms: averageTimeMs,
  });
}

export async function detectRtk(options = {}) {
  const execution = normalizeExecutionOptions(options);
  const minimumVersion = normalizeMinimumVersion(options.minimum_version);
  try {
    const result = await execution.executor(
      execution.executable,
      [...execution.prefix_args, "--version"],
      execution.process_options,
    );
    const parsed = parseRtkVersion(normalizeProcessOutput(result?.stdout), minimumVersion);
    return immutableJson({
      available: true,
      executable: execution.executable,
      ...parsed,
      reason: parsed.supported ? null : "version_below_minimum",
    });
  } catch (error) {
    if (error instanceof DomainValidationError) {
      return immutableJson({
        available: true,
        supported: false,
        executable: execution.executable,
        version: null,
        minimum_version: minimumVersion,
        gain_contract: null,
        reason: "unrecognized_version",
      });
    }
    return immutableJson({
      available: false,
      supported: false,
      executable: execution.executable,
      version: null,
      minimum_version: minimumVersion,
      gain_contract: null,
      reason: error?.code === "ENOENT" ? "not_found" : "execution_failed",
    });
  }
}

export async function collectRtkOptimizationTelemetry(options = {}) {
  const execution = normalizeExecutionOptions(options);
  const sourceCommand = Object.freeze([
    execution.executable,
    ...execution.prefix_args,
    ...buildRtkGainArgv(),
  ]);
  const unavailableSource = immutableJson({
    command: sourceCommand,
    shell: false,
    report_hash: null,
  });
  const detection = await detectRtk({
    ...options,
    executable: execution.executable,
    prefix_args: execution.prefix_args,
    executor: execution.executor,
  });
  if (!detection.available || !detection.supported) {
    return immutableJson({
      provider: RTK_ADAPTER_ID,
      status: detection.available ? "unsupported" : "unavailable",
      detection,
      classification: RTK_SAVINGS_CLASSIFICATION,
      enforcement: RTK_ENFORCEMENT_CLASSIFICATION,
      trusted_exact: false,
      scope: "project_cumulative",
      usage_credit_tokens: 0,
      source: unavailableSource,
      savings: null,
    });
  }
  let result;
  try {
    result = await execution.executor(
      execution.executable,
      [...execution.prefix_args, ...buildRtkGainArgv()],
      execution.process_options,
    );
  } catch (error) {
    throw new RtkExecutionError(`RTK gain collection failed for '${execution.executable}'`, {
      cause: error,
      code: error?.code === "ENOENT" ? "rtk_not_found" : "rtk_gain_failed",
      exit_code: error?.code ?? null,
      stderr: normalizeProcessOutput(error?.stderr),
    });
  }
  const stdout = normalizeProcessOutput(result?.stdout);
  let report;
  try {
    report = JSON.parse(stdout);
  } catch (error) {
    throw new RtkExecutionError("RTK gain output is not valid JSON", {
      cause: error,
      code: "invalid_rtk_gain_json",
      stderr: normalizeProcessOutput(result?.stderr),
    });
  }
  const savings = normalizeRtkGainReport(report);
  const source = immutableJson({
    command: sourceCommand,
    shell: false,
    report_hash: computeStableHash(report),
  });
  return immutableJson({
    provider: RTK_ADAPTER_ID,
    status: "operational",
    detection,
    classification: RTK_SAVINGS_CLASSIFICATION,
    enforcement: RTK_ENFORCEMENT_CLASSIFICATION,
    trusted_exact: false,
    scope: "project_cumulative",
    usage_credit_tokens: 0,
    source,
    savings,
  });
}

export function routeRtkCommand(command, options = {}) {
  const normalizedCommand = normalizeCommandVector(command);
  const profile = normalizeProfile(options.profile);
  const platform = normalizePlatform(options.platform);
  const executableToken = normalizedCommand[0];
  const executableName = normalizeGatewayExecutable(executableToken);
  const allowedProfile = inferAllowedProfile(executableName, normalizedCommand);
  if (!allowedProfile) {
    throw new DomainValidationError(
      "The optimization gateway accepts only fixed test commands, read-only Git status/diff/log/show/shortlog, and rg searches without external preprocessors",
    );
  }
  const executionCommand = buildExecutionCommand(executableName, normalizedCommand, {
    ...options,
    platform,
  });
  if (options.exact === true || profile === "native") {
    return immutableJson({
      mode: "native",
      profile: "native",
      command: normalizedCommand,
      execution_command: executionCommand,
      rtk_arguments: null,
      reason: options.exact === true ? "exact_output_requested" : "native_profile_requested",
    });
  }
  const selected = profile === "auto" ? inferProfile(executableName, normalizedCommand.slice(1)) : profile;
  if (selected === "native") {
    return immutableJson({
      mode: "native",
      profile: "native",
      command: normalizedCommand,
      execution_command: executionCommand,
      rtk_arguments: null,
      reason: "no_safe_filter_route",
    });
  }
  if (
    platform === "win32"
    && selected === executableName
    && ["git", "rg"].includes(selected)
  ) {
    // RTK's specialized git/rg profiles accept only arguments, not an
    // executable path. Native execution preserves the PATH-only absolute
    // resolution and prevents a project-local executable from being selected
    // again by an RTK subprocess.
    return immutableJson({
      mode: "native",
      profile: "native",
      command: normalizedCommand,
      execution_command: executionCommand,
      rtk_arguments: null,
      reason: "windows_absolute_executable_required",
    });
  }
  const rtkArguments = buildProfileArguments(
    selected,
    executableName,
    normalizedCommand,
    executionCommand,
  );
  return immutableJson({
    mode: "rtk",
    profile: selected,
    command: normalizedCommand,
    execution_command: executionCommand,
    rtk_arguments: rtkArguments,
    reason: profile === "auto" ? "automatic_supported_route" : "explicit_profile",
  });
}

function buildExecutionCommand(executableName, command, options = {}) {
  let executionCommand;
  if (executableName === "rg") {
    executionCommand = [command[0], "--no-config", ...command.slice(1)];
  } else if (executableName === "git" && ["diff", "log", "show"].includes(command[1])) {
    executionCommand = [
      command[0],
      command[1],
      "--no-ext-diff",
      "--no-textconv",
      ...command.slice(2),
    ];
  } else {
    executionCommand = [...command];
  }
  if (options.platform === "win32") {
    const extension = path.win32.extname(command[0]).toLowerCase();
    if (
      WINDOWS_NODE_SHIM_EXTENSIONS.has(extension)
      && !WINDOWS_NODE_SHIM_EXECUTABLES.has(executableName)
    ) {
      throw new DomainValidationError(
        `Windows command '${command[0]}' is a shell shim that this gateway cannot execute safely; use the corresponding .exe/.com command`,
      );
    }
    if (WINDOWS_NODE_SHIM_EXECUTABLES.has(executableName)) {
      return resolveShellFreeWindowsCommand(executionCommand, executableName, options);
    }
    return resolveShellFreeWindowsNativeCommand(executionCommand, options);
  }
  return Object.freeze(executionCommand);
}

function inferProfile(executableName, args) {
  if (executableName === "git") return isSafeGitCommand([executableName, ...args]) ? "git" : "native";
  if (executableName === "rg") return isSafeRgCommand([executableName, ...args]) ? "rg" : "native";
  if (isSafeFixedTestCommand(executableName, [executableName, ...args])) return "test";
  return "native";
}

function inferAllowedProfile(executableName, command) {
  if (executableName === "git") return isExecutionSafeGitCommand(command) ? "git" : null;
  if (executableName === "rg") return isExecutionSafeRgCommand(command) ? "rg" : null;
  return isSafeFixedTestCommand(executableName, command) ? "test" : null;
}

function buildProfileArguments(profile, executableName, command, executionCommand) {
  if (profile === "git" || profile === "rg") {
    if (executableName !== profile) {
      throw new DomainValidationError(`RTK profile '${profile}' requires a ${profile} command`);
    }
    if (profile === "git" && !isSafeGitCommand(command)) {
      throw new DomainValidationError("RTK git routing accepts only read-only status, diff, log, show, and shortlog commands");
    }
    if (profile === "rg" && !isSafeRgCommand(command)) {
      throw new DomainValidationError("RTK rg routing does not accept machine-readable JSON or NUL-delimited output");
    }
    if (profile === "rg") {
      // RIPGREP_CONFIG_PATH can add --pre or --search-zip without those flags
      // appearing in the caller's argv. The CLI override keeps the route closed.
      return Object.freeze([profile, ...executionCommand.slice(1)]);
    }
    return Object.freeze([profile, ...executionCommand.slice(1)]);
  }
  assertSafeFixedTestCommand(executableName, command);
  return Object.freeze([profile, ...executionCommand]);
}

function resolveShellFreeWindowsCommand(command, executableName, options) {
  const fsModule = options.fs_module ?? fs;
  const pathModule = path.win32;
  const cwd = options.cwd === undefined
    ? process.cwd()
    : normalizeSafeText(options.cwd, "optimization_windows_cwd", 4096);
  const environment = options.env ?? process.env;
  if (!environment || typeof environment !== "object" || Array.isArray(environment)) {
    throw new DomainValidationError("optimization Windows environment must be an object");
  }
  const nodeExecutable = options.node_executable === undefined
    ? process.execPath
    : normalizeSafeText(options.node_executable, "optimization_windows_node_executable", 4096);
  const resolved = resolveWindowsPathCommand({
    token: command[0],
    executable_name: executableName,
    cwd,
    environment,
    node_executable: nodeExecutable,
    fs_module: fsModule,
    path_module: pathModule,
  });
  return Object.freeze([
    resolved.executable,
    ...resolved.prefix_arguments,
    ...command.slice(1),
  ]);
}

function resolveShellFreeWindowsNativeCommand(command, options) {
  const fsModule = options.fs_module ?? fs;
  const pathModule = path.win32;
  const cwd = options.cwd === undefined
    ? process.cwd()
    : normalizeSafeText(options.cwd, "optimization_windows_cwd", 4096);
  const environment = options.env ?? process.env;
  if (!environment || typeof environment !== "object" || Array.isArray(environment)) {
    throw new DomainValidationError("optimization Windows environment must be an object");
  }
  const executable = resolveWindowsNativePathCommand({
    token: command[0],
    cwd,
    environment,
    fs_module: fsModule,
    path_module: pathModule,
  });
  return Object.freeze([
    executable,
    ...command.slice(1),
  ]);
}

function resolveWindowsNativePathCommand(options) {
  const {
    token,
    cwd,
    environment,
    fs_module: fsModule,
    path_module: pathModule,
  } = options;
  const extension = pathModule.extname(token).toLowerCase();
  const candidateExtensions = extension
    ? WINDOWS_NATIVE_EXECUTABLE_EXTENSIONS.has(extension) ? [extension] : []
    : DEFAULT_WINDOWS_PATHEXT.filter((candidate) => (
      WINDOWS_NATIVE_EXECUTABLE_EXTENSIONS.has(candidate)
    ));
  for (const directory of windowsSearchDirectories(cwd, environment, pathModule, fsModule)) {
    for (const candidateExtension of candidateExtensions) {
      const candidateName = extension ? token : `${token}${candidateExtension}`;
      const candidatePath = pathModule.join(directory, candidateName);
      if (isRegularFileNoFollow(candidatePath, fsModule)) return candidatePath;
    }
  }
  throw new DomainValidationError(
    `Windows command '${token}' could not be resolved to a PATH executable (.com or .exe)`,
  );
}

function resolveWindowsPathCommand(options) {
  const {
    token,
    executable_name: executableName,
    cwd,
    environment,
    node_executable: nodeExecutable,
    fs_module: fsModule,
    path_module: pathModule,
  } = options;
  const extension = pathModule.extname(token).toLowerCase();
  const searchDirectories = windowsSearchDirectories(cwd, environment, pathModule, fsModule);
  const candidateExtensions = extension
    ? WINDOWS_SAFE_PATHEXT.has(extension) ? [extension] : []
    : windowsPathExtensions(environment);
  for (const directory of searchDirectories) {
    for (const candidateExtension of candidateExtensions) {
      const candidateName = extension ? token : `${token}${candidateExtension}`;
      const candidatePath = pathModule.join(directory, candidateName);
      if (!isRegularFileNoFollow(candidatePath, fsModule)) continue;
      if (WINDOWS_NATIVE_EXECUTABLE_EXTENSIONS.has(candidateExtension)) {
        return {
          executable: candidatePath,
          prefix_arguments: [],
        };
      }
      const colocatedNode = pathModule.join(pathModule.dirname(candidatePath), "node.exe");
      const executable = isRegularFileNoFollow(colocatedNode, fsModule)
        ? colocatedNode
        : nodeExecutable;
      if (!isRegularFileNoFollow(executable, fsModule)) {
        throw new DomainValidationError(
          `Windows command '${token}' requires an existing Node executable for shell-free launch`,
        );
      }
      let launcher = readWindowsNodeShimLauncher(candidatePath, fsModule, pathModule);
      if (
        !launcher
        && executableName === "npm"
        && sameWindowsPath(
          pathModule.dirname(candidatePath),
          pathModule.dirname(executable),
          pathModule,
        )
      ) {
        // Recent official npm shims can choose a global-prefix launcher at
        // runtime. We cannot evaluate that shell logic, so only a shim inside
        // the same trusted Node installation may fall back to its verified,
        // regular npm-cli.js. An opaque shim earlier on PATH still fails closed.
        launcher = resolveKnownWindowsNodeLauncher(
          executableName,
          cwd,
          executable,
          fsModule,
          pathModule,
        );
      }
      if (!launcher) {
        throw new DomainValidationError(
          `Windows command '${token}' resolves to a command shim without a safe shell-free Node launcher`,
        );
      }
      return {
        executable,
        prefix_arguments: [launcher],
      };
    }
  }

  const directLauncher = resolveKnownWindowsNodeLauncher(
    executableName,
    cwd,
    nodeExecutable,
    fsModule,
    pathModule,
  );
  if (directLauncher) {
    return {
      executable: nodeExecutable,
      prefix_arguments: [directLauncher],
    };
  }
  throw new DomainValidationError(
    `Windows command '${token}' could not be resolved to an executable or safe shell-free Node launcher`,
  );
}

function windowsSearchDirectories(cwd, environment, pathModule, fsModule) {
  const pathValue = windowsEnvironmentValue(environment, "path");
  const configured = typeof pathValue === "string"
    ? pathValue.split(pathModule.delimiter)
    : [];
  const projectRoot = pathModule.resolve(cwd);
  const canonicalProjectRoot = realWindowsPath(projectRoot, fsModule, pathModule);
  if (!canonicalProjectRoot) {
    throw new DomainValidationError(
      "Windows optimization project root must exist and support canonical path resolution",
    );
  }
  // A relative PATH entry is implicitly project-relative because commands run
  // with cwd set to the project root. Absolute entries are still rejected when
  // either their lexical path or canonical junction/symlink target is inside
  // that project. Return the canonical directory so later executable lookup
  // cannot traverse the rejected alias again.
  const directories = configured
    .map((entry) => String(entry || "").trim().replace(/^"(.*)"$/u, "$1"))
    .filter(Boolean)
    .filter((entry) => isFullyQualifiedWindowsPath(entry, pathModule))
    .map((entry) => pathModule.resolve(entry))
    .filter((entry) => !isSameOrInsideWindowsPath(projectRoot, entry, pathModule))
    .map((entry) => realWindowsPath(entry, fsModule, pathModule))
    .filter(Boolean)
    .filter((entry) => !isSameOrInsideWindowsPath(
      canonicalProjectRoot,
      entry,
      pathModule,
    ));
  return Array.from(new Set(directories.map((entry) => entry.toLowerCase())))
    .map((normalized) => directories.find((entry) => entry.toLowerCase() === normalized));
}

function realWindowsPath(filePath, fsModule, pathModule) {
  const resolver = fsModule.realpathSync?.native ?? fsModule.realpathSync;
  if (typeof resolver !== "function") return null;
  try {
    const canonical = pathModule.resolve(resolver.call(fsModule, filePath));
    return isFullyQualifiedWindowsPath(canonical, pathModule)
      ? canonical
      : null;
  } catch {
    return null;
  }
}

function isFullyQualifiedWindowsPath(candidate, pathModule) {
  const windowsCandidate = String(candidate).replaceAll("/", "\\");
  if (
    windowsCandidate.startsWith("\\\\?\\")
    || windowsCandidate.startsWith("\\\\.\\")
    || windowsCandidate.startsWith("\\??\\")
    || windowsCandidate.startsWith("\\\\??\\")
  ) {
    return false;
  }
  const root = pathModule.parse(candidate).root;
  // UNC paths can alias a local project through an administrative share or a
  // user-defined SMB share while retaining a different canonical spelling.
  // This boundary therefore accepts only ordinary drive-qualified PATH
  // entries. Supporting a network tool directory requires a future explicit
  // trust record rather than inheriting ambient PATH authority.
  return pathModule.isAbsolute(candidate)
    && /^[a-z]:[\\/]$/iu.test(root);
}

function isSameOrInsideWindowsPath(boundary, candidate, pathModule) {
  const relative = pathModule.relative(
    pathModule.resolve(boundary),
    pathModule.resolve(candidate),
  );
  return relative === ""
    || (
      relative !== ".."
      && !relative.startsWith(`..${pathModule.sep}`)
      && !pathModule.isAbsolute(relative)
    );
}

function windowsPathExtensions(environment) {
  const configured = windowsEnvironmentValue(environment, "pathext");
  if (typeof configured !== "string" || configured.trim() === "") {
    return DEFAULT_WINDOWS_PATHEXT;
  }
  // Preserve host precedence while excluding file-association extensions
  // such as .js that cannot satisfy the shell-free executable boundary.
  const extensions = [];
  for (const entry of configured.split(";")) {
    const normalized = String(entry || "").trim().toLowerCase();
    const extension = normalized.startsWith(".") ? normalized : `.${normalized}`;
    if (
      normalized
      && WINDOWS_SAFE_PATHEXT.has(extension)
      && !extensions.includes(extension)
    ) {
      extensions.push(extension);
    }
  }
  return Object.freeze(extensions);
}

function windowsEnvironmentValue(environment, requestedName) {
  return Object.entries(environment)
    .find(([key]) => key.toLowerCase() === requestedName)?.[1];
}

function sameWindowsPath(left, right, pathModule) {
  return pathModule.resolve(left).toLowerCase() === pathModule.resolve(right).toLowerCase();
}

function readWindowsNodeShimLauncher(shimPath, fsModule, pathModule) {
  let entry;
  try {
    entry = fsModule.lstatSync(shimPath);
  } catch {
    return null;
  }
  if (
    entry.isSymbolicLink()
    || !entry.isFile()
    || !Number.isSafeInteger(entry.size)
    || entry.size < 1
    || entry.size > MAX_WINDOWS_SHIM_BYTES
  ) {
    return null;
  }
  let source;
  try {
    source = fsModule.readFileSync(shimPath, "utf8");
  } catch {
    return null;
  }
  const launcherDirectory = pathModule.dirname(shimPath);
  const lines = String(source).split(/\r?\n/u);
  const variableLaunchers = new Map();
  const nodeVariables = new Set();
  for (const line of lines) {
    const assignment = line.match(/^\s*@?set\s+"?([a-z0-9_]+)=([^"\r\n]+)"?\s*$/iu);
    if (!assignment) continue;
    const variableName = assignment[1].toLowerCase();
    const value = assignment[2].trim();
    const launcher = resolveWindowsShimJavascript(
      value,
      launcherDirectory,
      fsModule,
      pathModule,
    );
    if (launcher) variableLaunchers.set(variableName, launcher);
    else variableLaunchers.delete(variableName);
    if (isWindowsNodeCommandToken(value)) nodeVariables.add(variableName);
    else nodeVariables.delete(variableName);
  }
  for (const line of lines) {
    const launcher = parseWindowsNodeShimInvocation({
      line,
      launcher_directory: launcherDirectory,
      variable_launchers: variableLaunchers,
      node_variables: nodeVariables,
      fs_module: fsModule,
      path_module: pathModule,
    });
    if (launcher) return launcher;
  }
  return null;
}

function parseWindowsNodeShimInvocation(options) {
  const {
    line,
    launcher_directory: launcherDirectory,
    variable_launchers: variableLaunchers,
    node_variables: nodeVariables,
    fs_module: fsModule,
    path_module: pathModule,
  } = options;
  let candidate = String(line).trim();
  if (
    candidate === ""
    || /^\s*@?(?:::|rem(?:\s|$)|echo(?:[.:]|\s|$))/iu.test(candidate)
  ) {
    return null;
  }
  candidate = candidate.replace(/^@/u, "").trim();
  const generatedShimPrefix = (
    /^endlocal\s*&\s*goto\s+#_undefined_#\s+2>nul\s*\|\|\s*title\s+%comspec%\s*&\s*/iu
  );
  if (generatedShimPrefix.test(candidate)) {
    candidate = candidate.replace(generatedShimPrefix, "");
  } else if (/[&|<>]/u.test(candidate)) {
    return null;
  }
  const invocation = candidate.match(
    /^(?:"([^"]+)"|([^\s"&|<>]+))\s+(?:"([^"]+)"|([^\s"&|<>]+))\s+%\*\s*$/u,
  );
  if (!invocation) return null;
  const nodeToken = invocation[1] ?? invocation[2];
  const launcherToken = invocation[3] ?? invocation[4];
  if (!isWindowsNodeCommandToken(nodeToken, nodeVariables)) return null;
  const variableReference = launcherToken.match(/^%([a-z0-9_]+)%$/iu);
  if (variableReference) {
    return variableLaunchers.get(variableReference[1].toLowerCase()) || null;
  }
  return resolveWindowsShimJavascript(
    launcherToken,
    launcherDirectory,
    fsModule,
    pathModule,
  );
}

function resolveWindowsShimJavascript(value, launcherDirectory, fsModule, pathModule) {
  const relative = String(value).match(
    /^%(?:dp0%|~dp0)[\\/]+([^"%\r\n]+?\.(?:cjs|mjs|js))$/iu,
  );
  if (!relative || /[\u0000-\u001f\u007f]/u.test(relative[1])) return null;
  const launcher = pathModule.resolve(
    launcherDirectory,
    relative[1].replace(/[\\/]+/gu, pathModule.sep),
  );
  return isRegularFileNoFollow(launcher, fsModule) ? launcher : null;
}

function isWindowsNodeCommandToken(value, nodeVariables) {
  const token = String(value).trim();
  if (/^node(?:\.exe)?$/iu.test(token)) return true;
  if (/^%(?:dp0%|~dp0)[\\/]+node\.exe$/iu.test(token)) return true;
  const variableReference = token.match(/^%([a-z0-9_]+)%$/iu);
  return Boolean(
    variableReference
    && nodeVariables?.has(variableReference[1].toLowerCase()),
  );
}

function resolveKnownWindowsNodeLauncher(
  executableName,
  cwd,
  nodeExecutable,
  fsModule,
  pathModule,
) {
  if (!isRegularFileNoFollow(nodeExecutable, fsModule)) return null;
  const nodeRoot = pathModule.dirname(nodeExecutable);
  const candidates = {
    npm: [
      pathModule.join(nodeRoot, "node_modules", "npm", "bin", "npm-cli.js"),
    ],
    pnpm: [
      pathModule.join(nodeRoot, "node_modules", "corepack", "dist", "pnpm.js"),
      pathModule.join(nodeRoot, "node_modules", "pnpm", "bin", "pnpm.cjs"),
    ],
    yarn: [
      pathModule.join(nodeRoot, "node_modules", "corepack", "dist", "yarn.js"),
      pathModule.join(nodeRoot, "node_modules", "yarn", "bin", "yarn.js"),
    ],
    jest: [
      pathModule.join(cwd, "node_modules", "jest", "bin", "jest.js"),
    ],
    vitest: [
      pathModule.join(cwd, "node_modules", "vitest", "vitest.mjs"),
    ],
  };
  return (candidates[executableName] || [])
    .find((candidate) => isRegularFileNoFollow(candidate, fsModule)) || null;
}

function isRegularFileNoFollow(filePath, fsModule) {
  try {
    const entry = fsModule.lstatSync(filePath);
    return entry.isFile() && !entry.isSymbolicLink();
  } catch {
    return false;
  }
}

function isSafeGitCommand(command) {
  if (!isExecutionSafeGitCommand(command)) return false;
  const args = command.slice(2);
  const machineOutputFlags = [
    "-z", "--porcelain", "--raw", "--patch-with-raw", "--numstat", "--name-only",
    "--name-status", "--binary", "--format", "--pretty",
  ];
  return !args.some((arg) => (
    machineOutputFlags.some((flag) => arg === flag || arg.startsWith(`${flag}=`))
    || isCombinedShortFlag(arg, "z")
  ));
}

function isExecutionSafeGitCommand(command) {
  const subcommand = command[1];
  if (!SAFE_GIT_SUBCOMMANDS.has(subcommand)) return false;
  const args = command.slice(2);
  const sideEffectFlags = ["--output"];
  return !args.some((arg) => (
    sideEffectFlags.some((flag) => arg === flag || arg.startsWith(`${flag}=`))
    // Git's parse-options accepts unambiguous long-option abbreviations. Reject
    // every prefix it can expand to an external diff or text-conversion hook.
    || arg.startsWith("--ext")
    || arg.startsWith("--textc")
    // Signature display and %G pretty placeholders invoke the configured GPG
    // verifier, which is outside this fixed read-only command boundary.
    || arg.startsWith("--show-s")
    || ((arg.startsWith("--for") || arg.startsWith("--prett")) && arg.includes("%G"))
  )) && !args.some((arg, index) => (
    arg.includes("%G")
    && index > 0
    && ["--format", "--pretty"].includes(args[index - 1])
  ));
}

function isSafeRgCommand(command) {
  if (!isExecutionSafeRgCommand(command)) return false;
  const args = command.slice(1);
  const machineOutputFlags = ["--json", "--null", "--null-data", "--vimgrep"];
  return !args.some((arg) => machineOutputFlags.includes(arg) || isCombinedShortFlag(arg, "0"));
}

function isExecutionSafeRgCommand(command) {
  const args = command.slice(1);
  const externalProcessFlags = ["--pre", "--hostname-bin", "--search-zip"];
  return !args.some((arg) => (
    externalProcessFlags.some((flag) => arg === flag || arg.startsWith(`${flag}=`))
    || isCombinedShortFlag(arg, "z")
  ));
}

function isCombinedShortFlag(argument, flag) {
  return /^-[^-]/u.test(argument) && argument.slice(1).includes(flag);
}

function assertSafeFixedTestCommand(executableName, command) {
  if (isSafeFixedTestCommand(executableName, command)) return;
  throw new DomainValidationError(
    "RTK test routing accepts only fixed test commands (npm test, npm run test, pnpm/yarn/bun test, node --test, pytest, jest, or vitest)",
  );
}

function isSafeFixedTestCommand(executableName, command) {
  const args = command.slice(1);
  return (
    executableName === "npm" && (args.length === 1 && args[0] === "test" || args.length === 2 && args[0] === "run" && args[1] === "test")
  ) || (
    ["pnpm", "yarn", "bun"].includes(executableName) && args.length === 1 && args[0] === "test"
  ) || (
    executableName === "node" && args.length === 1 && args[0] === "--test"
  ) || (
    ["pytest", "jest", "vitest"].includes(executableName) && args.length === 0
  );
}

function normalizeCommandVector(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new DomainValidationError("optimization command must be a non-empty JSON array");
  }
  if (value.length > 128) {
    throw new DomainValidationError("optimization command cannot contain more than 128 arguments");
  }
  return Object.freeze(value.map((item, index) => normalizeCommandArgument(item, index)));
}

function normalizeCommandArgument(value, index) {
  if (typeof value !== "string") {
    throw new DomainValidationError(`optimization_command[${index}] must be a string`);
  }
  if (value.length > 4096 || (value !== "" && !SAFE_TEXT_PATTERN.test(value))) {
    throw new DomainValidationError(`optimization_command[${index}] contains unsupported characters or exceeds 4096 characters`);
  }
  if (index === 0 && value.length === 0) {
    throw new DomainValidationError("optimization_command[0] must be a non-empty executable name");
  }
  return value;
}

function normalizeGatewayExecutable(value) {
  const token = value.toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]*(?:\.(?:com|exe|cmd|bat))?$/u.test(token)) {
    throw new DomainValidationError("optimization command executable must be a bare command name without a path or shell metacharacters");
  }
  const executableName = token.replace(/\.(?:com|exe|cmd|bat)$/u, "");
  if (!SAFE_GATEWAY_EXECUTABLES.has(executableName)) {
    throw new DomainValidationError(`Unsupported optimization command executable '${value}'`);
  }
  return executableName;
}

function normalizeProfile(value) {
  const profile = value === undefined || value === null ? "auto" : requireNonEmptyString(String(value), "optimization_profile").toLowerCase();
  if (!SUPPORTED_PROFILES.has(profile)) {
    throw new DomainValidationError(`Unsupported optimization profile '${profile}'`);
  }
  return profile;
}

function normalizePlatform(value) {
  const platform = value === undefined
    ? process.platform
    : requireNonEmptyString(String(value), "optimization_platform").toLowerCase();
  if (!["aix", "darwin", "freebsd", "linux", "openbsd", "sunos", "win32"].includes(platform)) {
    throw new DomainValidationError(`Unsupported execution platform '${value}'`);
  }
  return platform;
}

function normalizeExecutionOptions(options) {
  requirePlainRecord(options, "rtk_execution_options");
  const executable = normalizeSafeText(options.executable ?? DEFAULT_EXECUTABLE, "rtk_execution_options.executable", 4096);
  const prefixArgs = options.prefix_args ?? [];
  if (!Array.isArray(prefixArgs)) {
    throw new DomainValidationError("rtk_execution_options.prefix_args must be an array");
  }
  const normalizedPrefixArgs = prefixArgs.map((value, index) => normalizeSafeText(value, `rtk_execution_options.prefix_args[${index}]`, 4096));
  const timeout = normalizeBoundedInteger(options.timeout_ms ?? DEFAULT_TIMEOUT_MS, "rtk_execution_options.timeout_ms", 1, MAX_TIMEOUT_MS);
  const maxBuffer = normalizeBoundedInteger(options.max_output_bytes ?? DEFAULT_MAX_OUTPUT_BYTES, "rtk_execution_options.max_output_bytes", 1024, MAX_OUTPUT_BYTES);
  const cwd = options.cwd === undefined ? process.cwd() : normalizeSafeText(options.cwd, "rtk_execution_options.cwd", 4096);
  const executor = options.executor ?? execFile;
  if (typeof executor !== "function") {
    throw new DomainValidationError("rtk_execution_options.executor must be a function");
  }
  return {
    executable,
    prefix_args: Object.freeze(normalizedPrefixArgs),
    executor,
    process_options: Object.freeze({ cwd, encoding: "utf8", timeout, maxBuffer, shell: false, windowsHide: true }),
  };
}

function normalizeMinimumVersion(value) {
  return effectiveMinimumVersion(value ?? RTK_MINIMUM_VERSION).version;
}

function effectiveMinimumVersion(value) {
  const configured = parseSemanticVersion(value ?? RTK_MINIMUM_VERSION, "rtk_minimum_version");
  const floor = parseSemanticVersion(RTK_MINIMUM_VERSION, "rtk_contract_minimum_version");
  return compareSemanticVersions(configured, floor) >= 0 ? configured : floor;
}

function parseSemanticVersion(value, label) {
  const raw = requireNonEmptyString(String(value), label);
  const match = raw.match(/^(\d+)\.(\d+)\.(\d+)$/u);
  if (!match) throw new DomainValidationError(`${label} must be a semantic version such as 0.43.0`);
  return { version: `${Number(match[1])}.${Number(match[2])}.${Number(match[3])}`, major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

function compareSemanticVersions(left, right) {
  return left.major - right.major || left.minor - right.minor || left.patch - right.patch;
}

function normalizeNonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new DomainValidationError(`${label} must be a non-negative safe integer`);
  return value;
}

function normalizePercentage(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) {
    throw new DomainValidationError(`${label} must be a finite percentage from 0 to 100`);
  }
  return value;
}

function normalizeOptionalNonNegativeNumber(value, label) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new DomainValidationError(`${label} must be a finite non-negative number when provided`);
  }
  return value;
}

function normalizeBoundedInteger(value, label, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new DomainValidationError(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function normalizeSafeText(value, label, maximumLength) {
  const normalized = requireNonEmptyString(String(value ?? ""), label);
  if (normalized.length > maximumLength || !SAFE_TEXT_PATTERN.test(normalized)) {
    throw new DomainValidationError(`${label} contains unsupported characters or exceeds ${maximumLength} characters`);
  }
  return normalized;
}

function normalizeProcessOutput(value) {
  if (value === undefined || value === null) return "";
  return Buffer.isBuffer(value) ? value.toString("utf8") : String(value);
}
