import path from "node:path";
import {
  validateAutonomyDecisionIntegrity,
  validateDeliveryExecutionProfileIntegrity,
  validateRequirementExecutionProfileIntegrity,
} from "../autonomy-policy.mjs";
import {
  commandMutationIntent,
} from "../cli/dispatch.mjs";
import {
  fail,
  failWithCode,
} from "../cli/user-error.mjs";
import {
  IDENTITY_STAT_OPTIONS,
  sameFileIdentityValues,
} from "../file-identity.mjs";
import {
  formatSchemaErrors,
  validateAgainstSchema,
} from "../json-schema-validator.mjs";
import {
  autonomyLifecycleReceiptHash,
  formalApprovalActorDescription,
  hasFormalApprovalAttribution,
  hashApprovalSubject,
  validateApprovalPolicy,
  validateApprovalSourceForActor,
} from "../lifecycle/authorization.mjs";
import {
  assertNotDerivedArtifact,
  shouldIndexFile,
  stableJson,
  validateBranchPolicy,
  validateRoutingPolicy,
  validateSdlcDirectoryList,
} from "../lifecycle/common.mjs";
import {
  PHASE_IDENTIFIER_PATTERN,
  PROJECT_CONFIG_LOCK_FILE_NAME,
  SDLC_DIR,
} from "../lifecycle/constants.mjs";
import {
  deliveryAutonomyRoot,
  deliveryExecutionProfileSchemaName,
} from "../lifecycle/delivery.mjs";
import {
  assertNoSymlinkPathSegments,
  assertPathInsideRoot,
  autonomyDecisionSemanticProjection,
  autonomyDecisionsRoot,
  autonomyRevocationSubject,
  autonomyRevocationsRoot,
  configuredRtkOptions,
  isInsidePath,
  normalizeProjectPathInput,
  readContextOptimizationPolicy,
  toProjectPath,
  validateAutonomyPolicy,
} from "../lifecycle/project.mjs";
import {
  requirementAutonomyRoot,
  requirementLifecycleRoot,
  validateClaimPolicy,
  validateStoryLifecyclePolicy,
  validateWorkBreakdownPolicy,
} from "../lifecycle/story.mjs";
import {
  RTK_ADAPTER_ID,
  collectRtkOptimizationTelemetry,
  detectRtk,
} from "../rtk-optimization-adapter.mjs";
import {
  fs,
  process,
} from "../runtime/host.mjs";
import {
  PLUGIN_ROOT,
} from "../runtime/paths.mjs";
import {
  orchestrationPolicy,
} from "../story-claim-shared-state.mjs";
import {
  validateApprovalEvidenceIntegrity,
  validateAutonomyApprovalRef,
  validateFormalApprovalRecord,
} from "./authorization.mjs";
import {
  appendRecordSchemaIssues,
  assertRecordSchema,
  fileSummary,
  missingProjectConfigGuidance,
  missingProjectConfigMessage,
  nearestExistingParent,
  uniqueRecordSuffix,
} from "./common.mjs";
import {
  currentDeliveryExecutionState,
  effectiveDeliveryProfileStatus,
  evaluateDeliveryAutonomy,
  readDeliveryAutonomyProfile,
  validateDeliveryExecutionReceipts,
} from "./delivery.mjs";
import {
  execGit,
} from "./git.mjs";
import {
  assertDirectoryIdentity,
  assertHealthyExistingBootstrapForOnboard,
} from "./migration.mjs";
import {
  output,
} from "./output.mjs";
import {
  readProjectJson,
  safeReadDir,
  walkFiles,
} from "./storage.mjs";
import {
  readRequirement,
  readStory,
  requirementSupersessionGovernanceErrors,
  validateRequirementLineage,
} from "./story.mjs";

export function pathEntryExistsNoFollow(filePath) {
  try {
    fs.lstatSync(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

export function assertConfigAllowsCommand(context, resolution, options, positionals = []) {
  if (
    resolution?.canonical_action === "onboard.existing-project"
    && pathEntryExistsNoFollow(context.sdlcRoot)
  ) {
    assertHealthyExistingBootstrapForOnboard(context);
  }
  if (!context.configState || context.configState.mutation_allowed !== false) return;
  // Without the project configuration even a read would present history
  // under the default privacy rules instead of the agreed ones. trace verify
  // only compares fingerprints and shows no recorded content, so it stays
  // available to check the history while the file is being restored.
  if (context.configState.status === "missing" && resolution?.canonical_action !== "trace.verify") {
    const defaultsSource = context.configState.restorable_defaults_path || null;
    failWithCode(
      "CONFIG_MISSING",
      missingProjectConfigMessage(defaultsSource),
      missingProjectConfigGuidance(defaultsSource),
    );
  }
  // Unknown commands and invalid metadata are deliberately treated as
  // mutations: configuration recovery must never guess that they are safe.
  if (resolution && commandMutationIntent(resolution, options) === false) return;
  const status = context.configState.status;
  fail([
    `This command was not run because the project configuration is ${status}.`,
    "Impact: no governed project files were changed.",
    status === "drifted"
      ? "Next: run `agentic-sdlc config migrate`, review the exact plan, and apply its hash before retrying."
      : `Next: inspect ${SDLC_DIR}/${PROJECT_CONFIG_LOCK_FILE_NAME}, or restore the last valid config and lock before retrying.`,
    `Technical detail: blocked command ${positionals.filter(Boolean).join(" ")}.`,
  ].join("\n"));
}

export function validateSdlcConfig(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    fail("SDLC config must be a JSON object");
  }
  const schemaPath = path.join(PLUGIN_ROOT, "schemas", "sdlc-config.schema.json");
  if (fs.existsSync(schemaPath)) {
    const schemaResult = validateAgainstSchema(config, "sdlc-config.schema.json", {
      schemaDir: path.dirname(schemaPath),
    });
    if (!schemaResult.valid) {
      fail(formatSchemaErrors("SDLC config", schemaResult.errors));
    }
  }
  for (const field of ["schema_version", "kb_directories", "phase_order", "phases", "gate_policy"]) {
    if (config[field] === undefined || config[field] === null) {
      fail(`SDLC config is missing required field '${field}'`);
    }
  }
  if (typeof config.schema_version !== "string" || !config.schema_version.trim()) {
    fail("SDLC config schema_version must be a non-empty string");
  }
  if (!Array.isArray(config.kb_directories) || config.kb_directories.length === 0) {
    fail("SDLC config kb_directories must be a non-empty array");
  }
  if (!Array.isArray(config.phase_order) || config.phase_order.length === 0) {
    fail("SDLC config phase_order must be a non-empty array");
  }
  if (!config.phases || typeof config.phases !== "object" || Array.isArray(config.phases)) {
    fail("SDLC config phases must be an object");
  }
  const configuredPhases = new Set();
  for (const phase of config.phase_order) {
    if (typeof phase !== "string" || !PHASE_IDENTIFIER_PATTERN.test(phase)) {
      fail(`SDLC config phase_order contains invalid phase identifier '${phase}'`);
    }
    if (configuredPhases.has(phase)) {
      fail(`SDLC config phase_order contains duplicate phase '${phase}'`);
    }
    configuredPhases.add(phase);
    if (!config.phases[phase] || typeof config.phases[phase] !== "object") {
      fail(`SDLC config phase_order references missing phase '${phase}'`);
    }
  }
  for (const phase of Object.keys(config.phases)) {
    if (!PHASE_IDENTIFIER_PATTERN.test(phase)) {
      fail(`SDLC config phases contains invalid phase identifier '${phase}'`);
    }
    if (!configuredPhases.has(phase)) {
      fail(`SDLC config phases contains '${phase}' but phase_order does not`);
    }
  }
  for (const [presetName, preset] of Object.entries(config.autonomy_policy?.presets || {})) {
    for (const phase of preset?.automatic_phases || []) {
      if (!configuredPhases.has(phase)) {
        fail(
          `SDLC config autonomy_policy.presets.${presetName}.automatic_phases `
          + `references unconfigured phase '${phase}'`,
        );
      }
    }
  }
  if (!config.gate_policy || typeof config.gate_policy !== "object" || Array.isArray(config.gate_policy)) {
    fail("SDLC config gate_policy must be an object");
  }
  for (const field of ["contract_required_fields", "story_required_fields"]) {
    if (!Array.isArray(config.gate_policy[field])) {
      fail(`SDLC config gate_policy.${field} must be an array`);
    }
  }
  validateSdlcDirectoryList(config.kb_directories, "kb_directories");
  validateSdlcDirectoryList(config.cache_policy?.source_of_truth_dirs, "cache_policy.source_of_truth_dirs");
  validateSdlcDirectoryList(config.cache_policy?.derived_directories, "cache_policy.derived_directories");
  validateRoutingPolicy(config.routing_policy);
  validateWorkBreakdownPolicy(config.work_breakdown_policy);
  validateApprovalPolicy(config.approval_policy);
  validateAutonomyPolicy(config.autonomy_policy);
  validateBranchPolicy(config.parallel_work);
  validateStoryLifecyclePolicy(config.story_lifecycle);
  validateClaimPolicy(config.claim_policy);
  try {
    orchestrationPolicy(config);
  } catch (error) {
    fail(`SDLC config ${error.message}`);
  }
  return config;
}

export function normalizePreflightWritePaths(context, paths) {
  return [...new Set(paths.map((rawPath) => {
    const resolved = resolveProjectFilePath(context, rawPath, { mustExist: false });
    return toProjectPath(context, resolved);
  }))].sort();
}

export function configuredRtkTrust(context, options = {}) {
  const policy = readContextOptimizationPolicy(context);
  const configuredExecutable = policy.provider.command.executable;
  const configuredCustom = configuredExecutable !== "rtk" || policy.provider.command.arguments.length > 0;
  if (configuredCustom) {
    const allowed = options.allow_custom_provider === true;
    return {
      allowed,
      custom: true,
      configured_executable: configuredExecutable,
      executable: configuredExecutable,
      execution_executable: allowed ? configuredExecutable : null,
      resolved_executable: null,
      reason: allowed ? null : "custom_provider_command_requires_explicit_trust",
    };
  }

  const resolved = resolveExecutableFromPath(configuredExecutable, context.root);
  if (!resolved) {
    return {
      allowed: false,
      custom: false,
      configured_executable: configuredExecutable,
      executable: configuredExecutable,
      execution_executable: null,
      resolved_executable: null,
      reason: "standard_provider_not_found",
    };
  }

  let canonicalRoot;
  try {
    canonicalRoot = fs.realpathSync(context.root);
  } catch {
    canonicalRoot = path.resolve(context.root);
  }
  const projectLocal = isInsidePath(context.root, resolved.candidate)
    || isInsidePath(context.root, resolved.realpath)
    || isInsidePath(canonicalRoot, resolved.candidate)
    || isInsidePath(canonicalRoot, resolved.realpath);
  const allowed = !projectLocal || options.allow_custom_provider === true;
  return {
    allowed,
    custom: projectLocal,
    configured_executable: configuredExecutable,
    executable: resolved.realpath,
    execution_executable: allowed ? resolved.realpath : null,
    resolved_executable: resolved.realpath,
    reason: allowed ? null : "project_local_standard_provider_requires_explicit_trust",
  };
}

export function resolveExecutableFromPath(executable, cwd) {
  const pathValue = Object.entries(process.env)
    .find(([key]) => key.toLowerCase() === "path")?.[1];
  if (!pathValue) return null;
  const extensions = process.platform === "win32" && path.extname(executable) === ""
    ? [
      "",
      ...String(process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD")
        .split(";")
        .map((extension) => extension.trim())
        .filter(Boolean),
    ]
    : [""];
  for (const rawEntry of String(pathValue).split(path.delimiter)) {
    const entry = rawEntry.startsWith('"') && rawEntry.endsWith('"')
      ? rawEntry.slice(1, -1)
      : rawEntry;
    const directory = entry === ""
      ? cwd
      : path.isAbsolute(entry) ? entry : path.resolve(cwd, entry);
    for (const extension of extensions) {
      const candidate = path.resolve(directory, `${executable}${extension}`);
      try {
        const stat = fs.statSync(candidate);
        if (!stat.isFile()) continue;
        fs.accessSync(candidate, process.platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK);
        return {
          candidate,
          realpath: fs.realpathSync(candidate),
        };
      } catch {
        // Match PATH lookup by continuing to the next candidate.
      }
    }
  }
  return null;
}

export async function detectConfiguredRtk(context, options = {}) {
  const trust = configuredRtkTrust(context, options);
  if (!trust.allowed) {
    return {
      available: false,
      supported: false,
      executable: trust.executable,
      minimum_version: readContextOptimizationPolicy(context).provider.minimum_version,
      version: null,
      gain_contract: null,
      reason: trust.reason,
    };
  }
  return detectRtk(configuredRtkOptions(context, trust));
}

export async function verifyConfiguredRtk(context, options = {}) {
  const trust = configuredRtkTrust(context, options);
  if (!trust.allowed) {
    return {
      provider: RTK_ADAPTER_ID,
      status: trust.custom ? "custom_provider_untrusted" : "unavailable",
      detection: await detectConfiguredRtk(context, options),
      classification: "estimated",
      enforcement: "advisory",
      trusted_exact: false,
      scope: "project_cumulative",
      usage_credit_tokens: 0,
      source: null,
      savings: null,
      reason: trust.reason,
    };
  }
  const configuredOptions = configuredRtkOptions(context, trust);
  try {
    return await collectRtkOptimizationTelemetry(configuredOptions);
  } catch (error) {
    return {
      provider: RTK_ADAPTER_ID,
      status: "telemetry_unavailable",
      detection: await detectRtk(configuredOptions),
      classification: "estimated",
      enforcement: "advisory",
      trusted_exact: false,
      scope: "project_cumulative",
      usage_credit_tokens: 0,
      source: null,
      savings: null,
      reason: error.code || "telemetry_collection_failed",
    };
  }
}

export function discoverExistingProjectDocuments(context) {
  const candidates = [];
  for (const name of ["README.md", "README.mdx", "readme.md", "ARCHITECTURE.md", "REQUIREMENTS.md"]) {
    const filePath = path.join(context.root, name);
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      candidates.push(toProjectPath(context, filePath));
    }
  }
  const docsRoot = path.join(context.root, "docs");
  if (fs.existsSync(docsRoot) && fs.statSync(docsRoot).isDirectory()) {
    const ranked = walkFiles(docsRoot)
      .filter((filePath) => shouldIndexFile(context, filePath) && /\.(?:md|mdx|txt)$/i.test(filePath))
      .sort((left, right) => {
        const score = (filePath) => /architecture|requirement|product|strategy|api|test|security|privacy|adr/i.test(path.basename(filePath)) ? 0 : 1;
        return score(left) - score(right) || left.localeCompare(right);
      })
      .slice(0, 12)
      .map((filePath) => toProjectPath(context, filePath));
    candidates.push(...ranked);
  }
  const seenFiles = new Set();
  return candidates
    .filter((projectPath) => {
      const filePath = resolveProjectFilePath(context, projectPath, { mustExist: true, fileOnly: true });
      const stat = fs.statSync(filePath);
      const identity = stat.ino
        ? `inode:${stat.dev}:${stat.ino}`
        : `realpath:${fs.realpathSync.native(filePath)}`;
      if (seenFiles.has(identity)) {
        return false;
      }
      seenFiles.add(identity);
      return true;
    })
    .slice(0, 12);
}

export function pullRequestChangedPaths(context, runtimeTarget, action) {
  let output = "";
  if (action === "git.commit") {
    output = [
      execGit(context.root, ["diff", "--name-only", "--cached"]),
      execGit(context.root, ["diff", "--name-only"]),
      execGit(context.root, ["ls-files", "--others", "--exclude-standard"]),
    ].filter(Boolean).join("\n");
  } else if (["git.push", "pull_request.create", "pull_request.update", "pull_request.merge"].includes(action)) {
    output = execGit(context.root, [
      "diff",
      "--name-only",
      `${runtimeTarget.base_sha}...${runtimeTarget.head_sha}`,
    ]) || "";
  }
  return [...new Set(output.split(/\r?\n/u).map((item) => item.trim()).filter(Boolean))].sort();
}

export function plannedRealPath(rawPath) {
  const targetPath = path.resolve(String(rawPath || ""));
  if (fs.existsSync(targetPath)) {
    return fs.realpathSync.native(targetPath);
  }
  const existingParent = nearestExistingParent(targetPath);
  if (!fs.statSync(existingParent).isDirectory() || fs.lstatSync(existingParent).isSymbolicLink()) {
    fail(`Nearest existing local-release parent must be a real directory: ${existingParent}.`);
  }
  assertNoSymlinkPathSegments(targetPath, existingParent);
  const relative = path.relative(existingParent, targetPath);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    fail(`Local release target cannot be resolved safely: ${targetPath}.`);
  }
  return path.resolve(fs.realpathSync.native(existingParent), relative);
}

export function readAutonomyProfileRevocation(context, filePath) {
  const record = readProjectJson(context, filePath);
  assertRecordSchema(
    record,
    "autonomy-profile-revocation.schema.json",
    `Autonomy profile revocation ${toProjectPath(context, filePath)}`,
  );
  if (record.receipt_hash !== autonomyLifecycleReceiptHash(record)) {
    fail(`Autonomy profile revocation hash is stale: ${toProjectPath(context, filePath)}.`);
  }
  if (record.approval?.status !== "approved") {
    fail(`Autonomy profile revocation ${record.id} lacks formal approval.`);
  }
  if (record.approval.approved_content_hash !== hashApprovalSubject(autonomyRevocationSubject(record))) {
    fail(`Autonomy profile revocation ${record.id} approval does not bind its exact subject.`);
  }
  validateApprovalSourceForActor(context, {
    source: record.approval.approval_source || null,
    status: record.approval.status,
    summary: record.approval.summary || null,
    evidence: Array.isArray(record.approval.evidence) ? record.approval.evidence : [],
    actor: record.approval.approved_by || null,
    label: `Autonomy profile revocation ${record.id}`,
  });
  validateApprovalEvidenceIntegrity(
    context,
    record.approval,
    `Autonomy profile revocation ${record.id} approval`,
  );
  const approvalReport = { strict: true, errors: [], warnings: [] };
  validateFormalApprovalRecord(
    context,
    approvalReport,
    record.approval,
    `Autonomy profile revocation ${record.id}`,
    record.approval.approved_by,
    { subject_id: record.profile_ref.id },
  );
  if (approvalReport.errors.length > 0) {
    fail(`Autonomy profile revocation ${record.id} governance is invalid: ${approvalReport.errors.join("; ")}`);
  }
  return record;
}

export function collectProjectKeyFiles(context) {
  const candidates = [
    "README.md",
    "package.json",
    "pnpm-lock.yaml",
    "package-lock.json",
    "yarn.lock",
    "tsconfig.json",
    "jsconfig.json",
    "vite.config.js",
    "vite.config.ts",
    "next.config.js",
    "next.config.mjs",
    "pyproject.toml",
    "requirements.txt",
    "Dockerfile",
    "docker-compose.yml",
    "go.mod",
    "Cargo.toml",
    "Package.swift",
    ".github/workflows",
  ];
  const files = [];
  for (const candidate of candidates) {
    const resolved = path.join(context.root, candidate);
    if (!fs.existsSync(resolved)) {
      continue;
    }
    const stat = fs.statSync(resolved);
    if (stat.isDirectory()) {
      for (const filePath of walkFiles(resolved)) {
        if (shouldIndexFile(context, filePath)) {
          files.push(fileSummary(context, filePath));
        }
      }
    } else if (stat.isFile()) {
      files.push(fileSummary(context, resolved));
    }
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

export function inferSourceRoots(context) {
  return ["src", "app", "pages", "lib", "bin", "server", "client"]
    .filter((entry) => fs.existsSync(path.join(context.root, entry)) && fs.statSync(path.join(context.root, entry)).isDirectory());
}

export function inferTestRoots(context) {
  return ["test", "tests", "__tests__", "spec", "e2e"]
    .filter((entry) => fs.existsSync(path.join(context.root, entry)) && fs.statSync(path.join(context.root, entry)).isDirectory());
}

export function detectProjectStack(context) {
  const detections = [];
  const add = (name, type, sourcePath, details = {}) => {
    detections.push({
      name,
      type,
      source_path: sourcePath,
      ...details,
    });
  };
  const has = (relativePath) => fs.existsSync(path.join(context.root, relativePath));
  if (has("package.json")) {
    const packageJsonPath = path.join(context.root, "package.json");
    add("package-json", "node", "package.json");
    try {
      const pkg = readProjectJson(context, packageJsonPath);
      const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
      for (const [dependency, type] of Object.entries({
        next: "web-framework",
        react: "frontend-library",
        vue: "frontend-framework",
        "@angular/core": "frontend-framework",
        svelte: "frontend-framework",
        vite: "build-tool",
        typescript: "language",
        jest: "test-runner",
        vitest: "test-runner",
        playwright: "browser-test-runner",
      })) {
        if (deps[dependency]) {
          add(dependency, type, "package.json", { version: deps[dependency] });
        }
      }
      if (pkg.scripts && Object.keys(pkg.scripts).length > 0) {
        add("npm-scripts", "automation", "package.json", { scripts: Object.keys(pkg.scripts).sort() });
      }
    } catch {
      add("package-json-unreadable", "warning", "package.json");
    }
  }
  for (const [relativePath, name, type] of [
    ["tsconfig.json", "typescript", "language"],
    ["next.config.js", "next", "web-framework"],
    ["next.config.mjs", "next", "web-framework"],
    ["vite.config.js", "vite", "build-tool"],
    ["vite.config.ts", "vite", "build-tool"],
    ["pyproject.toml", "python", "language"],
    ["requirements.txt", "python-requirements", "dependency-file"],
    ["Dockerfile", "docker", "container"],
    ["docker-compose.yml", "docker-compose", "container"],
    ["go.mod", "go", "language"],
    ["Cargo.toml", "rust", "language"],
    ["Package.swift", "swift-package", "language"],
    ["build.gradle", "gradle", "build-tool"],
    ["pom.xml", "maven", "build-tool"],
    ["terraform.tf", "terraform", "infrastructure"],
  ]) {
    if (has(relativePath)) {
      add(name, type, relativePath);
    }
  }
  return detections;
}

export function listProjectFilesUnder(context, directoryPath) {
  const files = [];
  for (const name of safeReadDir(directoryPath)) {
    const entryPath = path.join(directoryPath, name);
    let entry;
    try {
      entry = fs.lstatSync(entryPath);
    } catch {
      continue;
    }
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (name === ".git" || name === "node_modules") continue;
      files.push(...listProjectFilesUnder(context, entryPath));
    } else if (entry.isFile()) {
      files.push(toProjectPath(context, entryPath));
    }
  }
  return files;
}

export function resolveProjectFilePath(context, rawPath, options = {}) {
  const value = normalizeProjectPathInput(rawPath);
  if (!value) {
    fail("Path value cannot be empty");
  }
  const resolved = path.isAbsolute(value) ? path.resolve(value) : path.resolve(context.root, value);
  assertPathInsideRoot(context, resolved, value);
  if (options.mustExist && !fs.existsSync(resolved)) {
    fail(`Path does not exist: ${value}`);
  }
  if (fs.existsSync(resolved)) {
    const realRoot = fs.realpathSync.native(context.root);
    const realResolved = fs.realpathSync.native(resolved);
    if (!isInsidePath(realRoot, realResolved)) {
      fail(`Path resolves outside the target project root: ${value}`);
    }
    const stat = fs.statSync(resolved);
    if (options.fileOnly && !stat.isFile()) {
      fail(`Path is not a file: ${value}`);
    }
    if (options.directoryOnly && !stat.isDirectory()) {
      fail(`Path is not a directory: ${value}`);
    }
  } else {
    const nearestParent = nearestExistingParent(resolved);
    const realRoot = fs.realpathSync.native(context.root);
    const realParent = fs.realpathSync.native(nearestParent);
    if (!isInsidePath(realRoot, realParent)) {
      fail(`Path parent resolves outside the target project root: ${value}`);
    }
  }
  return resolved;
}

export function knowledgeSourceRoots(context) {
  const sourceDirs = context.config.cache_policy?.source_of_truth_dirs || [
    "contracts",
    "requirements",
    "stories",
    "decisions",
    "tests",
    "traces",
    "handoffs",
    "output-contracts",
    "work-items",
    "work-breakdown",
    "dependencies",
    "assumptions",
    "risks",
    "locks",
    "orchestration",
    "releases",
    "manifests",
    "archive",
    "reports",
  ];
  return ["project.json", ...sourceDirs];
}

export function assertContextSourcePathSafe(context, filePath, label) {
  assertNoSymlinkPathSegments(filePath, context.root);
  const realRoot = fs.realpathSync.native(context.root);
  const realPath = fs.realpathSync.native(filePath);
  if (!isInsidePath(realRoot, realPath)) {
    fail(`Path must stay inside the target project root: ${label}`);
  }
  const lexicalRealPath = path.join(context.root, path.relative(realRoot, realPath));
  assertNotDerivedArtifact(context, filePath, label);
  assertNotDerivedArtifact(context, lexicalRealPath, label);
  return realPath;
}

export function validateProject(context, report) {
  const projectPath = path.join(context.sdlcRoot, "project.json");
  if (!fs.existsSync(projectPath)) {
    report.errors.push("Missing .sdlc/project.json");
    return;
  }
  const project = readProjectJson(context, projectPath);
  for (const field of ["project_id", "project_name", "schema_version", "sdlc_version", "knowledge_base"]) {
    if (project[field] === undefined || project[field] === null || project[field] === "") {
      report.errors.push(`Project is missing required field '${field}'`);
    }
  }
  if (project.knowledge_base && project.knowledge_base.stateless_plugin !== true) {
    report.errors.push("Project knowledge_base.stateless_plugin must be true");
  }
  report.checked.push("project");
}

export function validateAutonomyRecords(
  context,
  report,
  storyId = null,
  { supersededLocalReleasePaths = null } = {},
) {
  const requirementProfileIds = storyId
    ? new Set((readStory(context, storyId)?.links?.requirements || []).map((requirementId) =>
        readRequirement(context, requirementId, { missingOk: true })?.autonomy_profile_id,
      ).filter(Boolean))
    : null;
  for (const name of safeReadDir(requirementAutonomyRoot(context)).filter((item) => item.endsWith(".json"))) {
    const profile = readProjectJson(context, path.join(requirementAutonomyRoot(context), name));
    if (requirementProfileIds && !requirementProfileIds.has(profile.id)) continue;
    const label = `requirement autonomy profile ${profile.id || name}`;
    appendRecordSchemaIssues(report, profile, "requirement-execution-profile.schema.json", label);
    const integrity = validateRequirementExecutionProfileIntegrity(profile);
    for (const error of integrity.errors || []) report.errors.push(`${label}: ${error}`);
    if (profile.status === "active") {
      try {
        const envelope = validateAutonomyApprovalRef(context, profile, label);
        const approval = envelope?.approval;
        if (!hasFormalApprovalAttribution(approval?.approved_by, approval?.approval_source)) {
          report.errors.push(`${label} approval is missing ${formalApprovalActorDescription(approval?.approval_source)} attribution`);
        }
        validateFormalApprovalRecord(context, report, approval, `${label} approval`, approval?.approved_by, {
          subject_id: profile.id,
        });
      } catch (error) {
        report.errors.push(`${label}: ${error.message}`);
      }
    }
    report.checked.push(label);
  }

  for (const name of safeReadDir(autonomyRevocationsRoot(context)).filter((item) => item.endsWith(".json"))) {
    const recordPath = path.join(autonomyRevocationsRoot(context), name);
    const raw = readProjectJson(context, recordPath);
    if (storyId) {
      const scopedProfile = readDeliveryAutonomyProfile(context, raw.profile_ref?.id || "missing", { missingOk: true });
      if (!scopedProfile || !(scopedProfile.story_refs || []).some((ref) => ref.id === storyId)) continue;
    }
    const label = `autonomy profile revocation ${raw.id || name}`;
    appendRecordSchemaIssues(report, raw, "autonomy-profile-revocation.schema.json", label);
    try {
      readAutonomyProfileRevocation(context, recordPath);
    } catch (error) {
      report.errors.push(`${label}: ${error.message}`);
    }
    report.checked.push(label);
  }

  const deliveryProfiles = [];
  for (const name of safeReadDir(deliveryAutonomyRoot(context)).filter((item) => item.endsWith(".json"))) {
    const profile = readProjectJson(context, path.join(deliveryAutonomyRoot(context), name));
    if (storyId && !(profile.story_refs || []).some((ref) => ref.id === storyId)) continue;
    const label = `delivery autonomy profile ${profile.id || name}`;
    deliveryProfiles.push(profile);
    appendRecordSchemaIssues(report, profile, deliveryExecutionProfileSchemaName(profile), label);
    const integrity = validateDeliveryExecutionProfileIntegrity(profile);
    for (const error of integrity.errors || []) report.errors.push(`${label}: ${error}`);
    if (profile.status === "active") {
      try {
        const envelope = validateAutonomyApprovalRef(context, profile, label);
        const approval = envelope?.approval;
        if (!hasFormalApprovalAttribution(approval?.approved_by, approval?.approval_source)) {
          report.errors.push(`${label} approval is missing ${formalApprovalActorDescription(approval?.approval_source)} attribution`);
        }
        validateFormalApprovalRecord(context, report, approval, `${label} approval`, approval?.approved_by, {
          subject_id: profile.id,
        });
        const effectiveStatus = effectiveDeliveryProfileStatus(context, profile);
        const executionState = currentDeliveryExecutionState(context, profile);
        validateDeliveryExecutionReceipts(context, report, profile, executionState, label, {
          supersededLocalReleasePaths,
        });
        if (effectiveStatus.status === "revoked") {
          report.warnings.push(`${label} is revoked and cannot authorize execution`);
          if (executionState.lifecycle_status === "started") {
            report.errors.push(`${label} is revoked but its started execution has no terminal revocation receipt`);
          }
        } else if (executionState.lifecycle_status !== "terminal") {
          const { decision } = evaluateDeliveryAutonomy(context, profile, {
            id: `AUT-GATE-${uniqueRecordSuffix()}`,
          });
          const invalid = decision.source_constraints.filter((constraint) => !constraint.valid);
          if (decision.blocked || invalid.length > 0) {
            report.errors.push(`${label} fails current evaluation: ${[
              ...decision.reason_codes,
              ...invalid.flatMap((constraint) => constraint.reason_codes),
            ].filter(Boolean).join(", ") || "invalid boundary"}`);
          }
        }
      } catch (error) {
        report.errors.push(`${label}: ${error.message}`);
      }
    }
    report.checked.push(label);
  }

  const deliveryById = new Map(deliveryProfiles.map((profile) => [profile.id, profile]));
  for (const name of safeReadDir(autonomyDecisionsRoot(context)).filter((item) => item.endsWith(".json"))) {
    const decision = readProjectJson(context, path.join(autonomyDecisionsRoot(context), name));
    if (storyId) {
      const profile = deliveryById.get(decision.delivery?.profile_id);
      if (!profile || !(profile.story_refs || []).some((ref) => ref.id === storyId)) continue;
    }
    const label = `autonomy decision ${decision.id || name}`;
    appendRecordSchemaIssues(report, decision, "autonomy-decision.schema.json", label);
    const integrity = validateAutonomyDecisionIntegrity(decision);
    for (const error of integrity.errors || []) report.errors.push(`${label}: ${error}`);
    const profile = deliveryById.get(decision.delivery?.profile_id)
      || readDeliveryAutonomyProfile(context, decision.delivery?.profile_id || "missing", { missingOk: true });
    if (!profile || profile.profile_hash !== decision.delivery?.profile_hash) {
      report.errors.push(`${label} references a missing or stale delivery profile`);
    } else {
      const executionState = currentDeliveryExecutionState(context, profile);
      const revoked = effectiveDeliveryProfileStatus(context, profile).status === "revoked";
      if (executionState.lifecycle_status !== "terminal" && !revoked) {
        try {
          const { decision: freshDecision } = evaluateDeliveryAutonomy(context, profile, {
            id: decision.id,
            phase: decision.phase || undefined,
            evaluated_at: decision.evaluated_at,
          });
          if (stableJson(autonomyDecisionSemanticProjection(decision)) !== stableJson(autonomyDecisionSemanticProjection(freshDecision))) {
            report.errors.push(`${label} does not match a fresh deterministic evaluation of its bound profile`);
          }
        } catch (error) {
          report.errors.push(`${label} cannot be reproduced from its bound profile: ${error.message}`);
        }
      }
    }
    report.checked.push(label);
  }

  for (const name of safeReadDir(requirementLifecycleRoot(context)).filter((item) => item.endsWith(".json"))) {
    const event = readProjectJson(context, path.join(requirementLifecycleRoot(context), name));
    if (storyId) {
      const ids = new Set(readStory(context, storyId)?.links?.requirements || []);
      if (!ids.has(event.requirement_ref?.id) && !ids.has(event.replacement_ref?.id)) continue;
    }
    appendRecordSchemaIssues(report, event, "requirement-lifecycle-event.schema.json", `requirement lifecycle event ${event.id || name}`);
    for (const error of requirementSupersessionGovernanceErrors(context, event)) {
      report.errors.push(error);
    }
    report.checked.push(`requirement lifecycle event ${event.id || name}`);
  }
  validateRequirementLineage(context, report, storyId);
}

export function verifyOpenFileMatchesPath(descriptor, filePath, parentIdentity) {
  const descriptorStat = fs.fstatSync(descriptor);
  if (!descriptorStat.isFile()) {
    fail(`Refusing non-regular file: ${filePath}`);
  }
  assertDirectoryIdentity(path.dirname(filePath), parentIdentity);
  const pathStat = fs.lstatSync(filePath, IDENTITY_STAT_OPTIONS);
  if (
    pathStat.isSymbolicLink()
    || !sameFileIdentityValues(pathStat, fs.fstatSync(descriptor, IDENTITY_STAT_OPTIONS))
  ) {
    fail(`File changed while opening it: ${filePath}`);
  }
  return descriptorStat;
}
