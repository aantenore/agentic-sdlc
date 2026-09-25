import path from "node:path";
import {
  computeStableHash,
} from "../canonical.mjs";
import {
  fail,
} from "../cli/user-error.mjs";
import {
  DEFAULT_DELIVERY_PROVIDER_SELECTION,
  createDefaultDeliveryProviderRegistry,
} from "../delivery/default-providers.mjs";
import {
  providerBindingForAction,
} from "../delivery/provider-compatibility.mjs";
import {
  DeliveryProviderError,
  assertProviderOperationReceiptIntegrity,
} from "../delivery/provider-registry.mjs";
import {
  deliveryProviderOperationSubjectsMatch,
} from "../delivery/provider-subject-compatibility.mjs";
import {
  hashApprovalSubject,
} from "./authorization.mjs";
import {
  getOptionString,
  hashBoundRecordIsValid,
  matchesAny,
  normalizeId,
  normalizeListOption,
  normalizeRawListOption,
  overlaps,
  shortHashFull,
  slugify,
  stableJson,
} from "./common.mjs";
import {
  DELIVERY_BOUNDARY_CHECKPOINT_ACTIONS,
  DELIVERY_PROVIDER_ACTIONS,
  PROJECT_CONFIG_FILE_NAME,
  REVERSIBLE_DATA_ACTIONS,
  ROLLBACK_VERIFICATION_ACTIONS,
  SDLC_DIR,
} from "./constants.mjs";
import {
  autonomyActionsRoot,
  autonomyExecutionsRoot,
  autonomyRoot,
  configuredSdlcDirectory,
  isInsidePath,
  toProjectPath,
} from "./project.mjs";
import {
  autonomyActionIntentsRoot,
} from "./route.mjs";
import {
  configuredPhaseOrder,
  storyAcceptanceCriteria,
} from "./story.mjs";

export function exactGitProjectPath(rawPath) {
  const value = String(rawPath);
  if (
    !value
    || value.includes("\u0000")
    || path.posix.isAbsolute(value)
    || /^[a-z]:[\\/]/iu.test(value)
    || value.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    fail(`Execution context preflight received an unsafe Git path: ${JSON.stringify(value)}`);
  }
  return value;
}

export function deliveryAutonomyRoot(context) {
  return path.join(autonomyRoot(context), "deliveries");
}

export function deliveryExecutionRoot(context, profileId) {
  return path.join(autonomyExecutionsRoot(context), normalizeId(profileId));
}

export function deliveryActionAttemptsRoot(context, profileId) {
  return path.join(deliveryExecutionRoot(context, profileId), "attempts");
}

export function deliveryActionAttemptPath(context, profileId, attemptId) {
  return path.join(
    deliveryActionAttemptsRoot(context, profileId),
    `${normalizeId(attemptId)}.json`,
  );
}

export function deliveryStartReceiptPath(context, profileId) {
  return path.join(deliveryExecutionRoot(context, profileId), "start.json");
}

export function deliveryCloseReceiptPath(context, profileId) {
  return path.join(deliveryExecutionRoot(context, profileId), "close.json");
}

export function deliveryAutonomyPath(context, profileId) {
  return path.join(deliveryAutonomyRoot(context), `${normalizeId(profileId)}.json`);
}

export function deliveryExecutionProfileSchemaName(profile) {
  if (profile?.schema_version === "delivery-execution-profile:v2") {
    return "delivery-execution-profile-v2.schema.json";
  }
  if (profile?.schema_version === "delivery-execution-profile:v1") {
    return "delivery-execution-profile.schema.json";
  }
  fail(`Unsupported delivery profile schema '${profile?.schema_version || "missing"}'.`);
}

export function configuredDeliveryProviderSelection(context) {
  const configured = context.config.autonomy_policy?.delivery_providers || {};
  return {
    git_push: configured.git_push || DEFAULT_DELIVERY_PROVIDER_SELECTION.git_push,
    pull_request: configured.pull_request || DEFAULT_DELIVERY_PROVIDER_SELECTION.pull_request,
    local_release: configured.local_release || DEFAULT_DELIVERY_PROVIDER_SELECTION.local_release,
  };
}

export function normalizeDeliveryProviderId(value, label) {
  const providerId = String(value || "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]*$/u.test(providerId)) {
    fail(`${label} must be a safe provider id, for example git-remote or github-cli.`);
  }
  return providerId;
}

export function deliveryProviderBindingsFromOptions(context, kind, options, target) {
  const configured = configuredDeliveryProviderSelection(context);
  const pullRequestActions = target?.pull_request_target?.mode === "existing"
    ? ["pull_request.merge", "pull_request.update"]
    : ["pull_request.create", "pull_request.merge", "pull_request.update"];
  const selected = kind === "pull_request"
    ? [
        {
          action: "git.push",
          provider_id: normalizeDeliveryProviderId(
            getOptionString(options, "git-provider") || configured.git_push,
            "Git provider",
          ),
        },
        ...pullRequestActions.map((action) => ({
          action,
          provider_id: normalizeDeliveryProviderId(
            getOptionString(options, "pull-request-provider") || configured.pull_request,
            "Pull-request provider",
          ),
        })),
      ]
    : [
        ...(target?.local_release_target?.data_migration
          ? ["data.migrate", "data.rollback"]
          : []),
        "release.local",
        ...(target?.local_release_target?.rollback?.verification_required === true
          ? ["rollback.verify"]
          : []),
      ].map((action) => ({
        action,
        provider_id: normalizeDeliveryProviderId(
          getOptionString(options, "local-release-provider") || configured.local_release,
          "Local-release provider",
        ),
      }));
  const registry = createDefaultDeliveryProviderRegistry();
  for (const binding of selected) {
    try {
      if (
        !registry.supports(binding.provider_id, binding.action, "precondition")
        || !registry.supports(binding.provider_id, binding.action, "completion")
      ) {
        fail(`The selected provider cannot verify ${binding.action}; choose a compatible installed provider.`);
      }
    } catch (error) {
      if (error instanceof DeliveryProviderError) {
        fail(`The selected provider cannot verify ${binding.action}; choose a compatible installed provider.`);
      }
      throw error;
    }
  }
  return selected.sort((left, right) => left.action.localeCompare(right.action));
}

export function normalizeDeliveryAction(kind, value) {
  const raw = String(value || "").trim().toLowerCase();
  const aliases = {
    implement: "repository.write",
    read: "repository.read",
    test: "test.run",
    commit: "git.commit",
    push: "git.push",
    update: "pull_request.update",
    merge: "pull_request.merge",
    build: "build.local",
    migrate: "data.migrate",
    rollback: "data.rollback",
    "verify-rollback": "rollback.verify",
    release: "release.local",
  };
  const action = aliases[raw] || raw;
  const catalog = kind === "pull_request"
    ? new Set([
        "repository.read",
        "repository.write",
        "test.run",
        "git.commit",
        "git.push",
        "pull_request.create",
        "pull_request.update",
        "pull_request.merge",
      ])
    : new Set([
        "build.local",
        "data.migrate",
        "data.rollback",
        "rollback.verify",
        "test.run",
        "release.local",
      ]);
  if (!catalog.has(action)) {
    fail(`Unknown ${kind} delivery action '${value}'. Valid actions: ${[...catalog].sort().join(", ")}.`);
  }
  return action;
}

export function gitRuntimeWithoutHead(runtimeTarget) {
  const { head_sha: _headSha, ...boundary } = runtimeTarget || {};
  return boundary;
}

export function gitRuntimeWithoutBaseSha(runtimeTarget) {
  const { base_sha: _baseSha, ...boundary } = runtimeTarget || {};
  return boundary;
}

export function resolveDeliveryProviderBinding(profile, action) {
  if (!DELIVERY_PROVIDER_ACTIONS.has(action)) return null;
  try {
    const binding = providerBindingForAction(profile, action);
    if (!binding) {
      fail(`This delivery has no verification provider for ${action}; create a new delivery choice with an explicit provider.`);
    }
    if (binding.compatibility === "unsupported-fail-closed") {
      fail(`This historical delivery cannot safely verify ${action}; create a new delivery choice with a compatible provider.`);
    }
    const registry = createDefaultDeliveryProviderRegistry();
    if (
      !registry.supports(binding.provider_id, action, "precondition")
      || !registry.supports(binding.provider_id, action, "completion")
    ) {
      fail(`The provider selected for ${action} cannot verify both the before and after state.`);
    }
    return binding;
  } catch (error) {
    if (error instanceof DeliveryProviderError) {
      fail(`The delivery provider for ${action} is unavailable or incompatible.`);
    }
    throw error;
  }
}

export function deliveryProviderOperationSubject(context, profile, action, actionDetails, authorizedAt) {
  if (action === "git.push") {
    return {
      repository: profile.pull_request_target.repository,
      remote: actionDetails.push.remote,
      destination_ref: actionDetails.push.destination_ref,
      base_ref: `refs/heads/${profile.pull_request_target.base_branch}`,
      source_sha: actionDetails.push.source_sha,
    };
  }
  if (["pull_request.create", "pull_request.merge", "pull_request.update"].includes(action)) {
    const subject = {
      repository: profile.pull_request_target.repository,
      head_branch: profile.pull_request_target.head_branch,
      base_branch: profile.pull_request_target.base_branch,
      source_sha: actionDetails.source_sha,
      authorized_at: authorizedAt,
    };
    if (action !== "pull_request.create") subject.pr_url = actionDetails.pull_request?.pr_url;
    if (action === "pull_request.merge" && actionDetails.merge?.base_sha) {
      subject.base_sha = actionDetails.merge.base_sha;
    }
    if (action === "pull_request.update") subject.expected = actionDetails.pull_request?.expected;
    return subject;
  }
  if (action === "release.local") {
    return {
      root_path: profile.local_release_target.root_path,
      allowed_write_paths: profile.local_release_target.allowed_write_paths,
    };
  }
  if (action === "rollback.verify") {
    const verification = actionDetails.rollback_verification;
    return {
      root_path: verification.target_root,
      allowed_write_paths: verification.allowed_write_paths,
      rollback_procedure: verification.rollback_procedure,
      evidence_root: verification.evidence_root,
      evidence: verification.evidence.map((item) => ({
        path: path.resolve(verification.evidence_root, item.path),
        sha256: item.sha256,
      })),
    };
  }
  if (["data.migrate", "data.rollback"].includes(action)) {
    const migration = profile.local_release_target.data_migration;
    return {
      root_path: profile.local_release_target.root_path,
      target_path: migration.target_path,
      scopes: migration.scopes,
      preview_evidence: migration.preview_evidence,
      backup_path: migration.backup.path,
      rollback: profile.local_release_target.rollback.procedure,
    };
  }
  return null;
}

export function withProviderCompatibilityProjection(action, actionDetails, providerOperation) {
  const precondition = providerOperation?.precondition_receipt?.proof;
  const completion = providerOperation?.completion_receipt?.proof;
  let projected = { ...actionDetails, provider_operation: providerOperation };
  if (action === "git.push") {
    projected = {
      ...projected,
      base_precondition: {
        provider: providerOperation.binding.provider_id,
        remote: precondition.remote,
        base_ref: precondition.base_ref,
        observed_sha: precondition.base_sha,
      },
      push_precondition: {
        provider: providerOperation.binding.provider_id,
        remote: precondition.remote,
        destination_ref: precondition.destination_ref,
        observed_sha: precondition.previous_sha,
      },
    };
    if (completion) {
      projected.remote_verification = {
        provider: providerOperation.binding.provider_id,
        remote: completion.remote,
        destination_ref: completion.destination_ref,
        observed_sha: completion.observed_sha,
        verified_at: providerOperation.completion_receipt.observed_at,
      };
    }
  }
  if (["pull_request.create", "pull_request.merge", "pull_request.update"].includes(action)) {
    const legacyPrecondition = { provider: providerOperation.binding.provider_id, ...precondition };
    if (action === "pull_request.merge") projected.merge_precondition = legacyPrecondition;
    else projected.provider_precondition = legacyPrecondition;
    if (completion) projected.provider_verification = { provider: providerOperation.binding.provider_id, ...completion };
  }
  return projected;
}

export function assertDeliveryProviderAuthorization(context, profile, authorization) {
  if (!DELIVERY_PROVIDER_ACTIONS.has(authorization.action)) return;
  const providerOperation = authorization.action_details?.provider_operation;
  if (!providerOperation) {
    if (profile.schema_version === "delivery-execution-profile:v1") return;
    fail(`Delivery action authorization ${authorization.id} has no provider precondition proof.`);
  }
  const binding = resolveDeliveryProviderBinding(profile, authorization.action);
  let precondition;
  try {
    precondition = assertProviderOperationReceiptIntegrity(providerOperation.precondition_receipt);
  } catch (error) {
    fail(`Delivery action authorization ${authorization.id} has an invalid provider precondition proof: ${error.message}`);
  }
  const expectedSubject = deliveryProviderOperationSubject(
    context,
    profile,
    authorization.action,
    authorization.action_details,
    authorization.authorized_at,
  );
  if (
    providerOperation.completion_receipt !== null
    || providerOperation.binding?.action !== authorization.action
    || providerOperation.binding?.provider_id !== binding.provider_id
    || providerOperation.binding?.provider_bindings_hash !== (profile.provider_bindings_hash || null)
    || precondition.provider.id !== binding.provider_id
    || precondition.operation.id !== authorization.id
    || precondition.operation.action !== authorization.action
    || precondition.operation.phase !== "precondition"
    || !deliveryProviderOperationSubjectsMatch(authorization.action, precondition.subject, expectedSubject)
  ) {
    fail(`Delivery action authorization ${authorization.id} provider proof does not match its exact action boundary.`);
  }
  if (authorization.action === "pull_request.merge" && authorization.action_details?.merge?.base_sha !== undefined) {
    const authorizedBaseSha = authorization.runtime_target?.base_sha;
    if (
      authorization.action_details.merge.base_sha !== authorizedBaseSha
      || precondition.subject?.base_sha !== authorizedBaseSha
      || precondition.proof?.base_sha !== authorizedBaseSha
    ) {
      fail(`Delivery action authorization ${authorization.id} does not cross-bind its exact runtime and GitHub base SHA.`);
    }
  }
}

export function normalizeSmokeTestCommand(value) {
  const raw = String(value || "").trim();
  let argv;
  try {
    argv = JSON.parse(raw);
  } catch {
    fail(`Smoke test must be a shell-free JSON argv array, for example '["node","--version"]': ${raw}`);
  }
  if (
    !Array.isArray(argv)
    || argv.length === 0
    || argv.some((item) => typeof item !== "string" || item.length === 0 || item.includes("\0"))
  ) {
    fail("Smoke test JSON must be a non-empty array of non-empty strings.");
  }
  const executable = path.basename(argv[0]).toLowerCase();
  if ([
    "sh",
    "bash",
    "zsh",
    "dash",
    "ksh",
    "csh",
    "tcsh",
    "fish",
    "cmd",
    "cmd.exe",
    "powershell",
    "powershell.exe",
    "pwsh",
    "pwsh.exe",
  ].includes(executable)) {
    fail(`Smoke test shell executable '${argv[0]}' is not allowed; use a direct argv command.`);
  }
  if (["env", "xargs", "nice", "nohup", "arch", "xcrun"].includes(executable)) {
    fail(
      `Smoke test dispatcher '${argv[0]}' is not allowed; invoke the reviewed executable directly.`,
    );
  }
  if (
    /^(?:node(?:js)?|python(?:\d+(?:\.\d+)*)?|ruby|perl|php)(?:[-.]\d.*)?$/u.test(executable)
    && argv.slice(1).some((item) =>
      /^(?:-e|--eval|-c|--print|-p)(?:=|.+)?$/u.test(String(item)))
  ) {
    fail(`Smoke test inline code execution is not allowed for ${argv[0]}.`);
  }
  if (["npx", "npx.cmd", "npx.exe", "bunx"].includes(executable)) {
    fail(
      `Smoke test package dispatcher '${argv[0]}' is not allowed; run a reviewed package script instead.`,
    );
  }
  if ([
    "npm",
    "npm.cmd",
    "npm.exe",
    "pnpm",
    "pnpm.cmd",
    "pnpm.exe",
    "yarn",
    "yarn.cmd",
    "yarn.exe",
    "bun",
  ].includes(executable)) {
    const operation = String(argv[1] || "").toLowerCase();
    if (
      !(
        operation === "test"
        || (operation === "run" && typeof argv[2] === "string" && !argv[2].startsWith("-"))
      )
    ) {
      fail(
        `Package-manager smoke test '${argv[0]}' must use 'test' or 'run <reviewed-script>'.`,
      );
    }
  }
  return stableJson(argv);
}

export function governedLocalSmokeCwd(profile) {
  const target = profile.local_release_target || {};
  const allowedWritePaths = [...new Set((target.allowed_write_paths || [])
    .map((item) => path.resolve(String(item))))].sort();
  let smokeCwd = target.smoke_cwd
    ? path.resolve(String(target.smoke_cwd))
    : null;
  if (!smokeCwd) {
    if (allowedWritePaths.length !== 1) {
      fail(
        `Historical local-release profile ${profile.id || "unknown"} has no governed smoke working directory `
        + `and ${allowedWritePaths.length} allowed write paths. Create a new delivery profile with --smoke-cwd.`,
      );
    }
    smokeCwd = allowedWritePaths[0];
  }
  const containingWritePath = allowedWritePaths.find((writePath) => isInsidePath(writePath, smokeCwd));
  if (!containingWritePath) {
    fail("Local release smoke working directory is outside the approved write paths.");
  }
  return { smokeCwd, containingWritePath };
}

export function localSmokeExecutableBase(value) {
  return path.basename(String(value || "")).toLowerCase();
}

export function localSmokePackageManager(command) {
  const executable = localSmokeExecutableBase(command?.[0]);
  if (["npm", "npm.cmd", "npm.exe"].includes(executable)) return "npm";
  if (["pnpm", "pnpm.cmd", "pnpm.exe"].includes(executable)) return "pnpm";
  if (["yarn", "yarn.cmd", "yarn.exe"].includes(executable)) return "yarn";
  if (executable === "bun") return "bun";
  return null;
}

export function validateLocalSmokePackageManagerForm(command) {
  const manager = localSmokePackageManager(command);
  if (!manager) return null;
  const operation = String(command[1] || "").toLowerCase();
  if (
    !(
      operation === "test"
      || (operation === "run" && typeof command[2] === "string" && !command[2].startsWith("-"))
    )
  ) {
    fail(
      `Package-manager smoke test '${command[0]}' must use 'test' or `
      + "'run <reviewed-script>' from the governed package.json.",
    );
  }
  return manager;
}

export function validateResolvedLocalSmokeExecutable(resolvedCommand) {
  const executable = localSmokeExecutableBase(resolvedCommand.realpath);
  if ([
    "sh",
    "bash",
    "zsh",
    "dash",
    "ksh",
    "csh",
    "tcsh",
    "fish",
    "cmd",
    "cmd.exe",
    "powershell",
    "powershell.exe",
    "pwsh",
    "pwsh.exe",
  ].includes(executable)) {
    fail(
      `Local smoke executable resolves to shell '${resolvedCommand.realpath}'. `
      + "Invoke a reviewed artifact entrypoint directly.",
    );
  }
  if (["env", "xargs", "nice", "nohup", "time", "arch", "xcrun"].includes(executable)) {
    fail(
      `Local smoke executable resolves to indirect dispatcher '${resolvedCommand.realpath}'. `
      + "Invoke the reviewed runtime or artifact entrypoint directly.",
    );
  }
}

export function localSmokeInterpreterOptionValueKind(runtimeBase, argument) {
  const value = String(argument);
  if (/^(?:node(?:js)?|bun|deno)(?:[-.]\d.*)?$/u.test(runtimeBase)) {
    if (new Set([
      "--conditions",
      "--dns-result-order",
      "--input-type",
      "--inspect-port",
      "--stack-trace-limit",
      "--test-concurrency",
      "--test-name-pattern",
      "--title",
      "--unhandled-rejections",
    ]).has(value)) return "scalar";
    if (new Set([
      "--test-reporter",
      "--test-reporter-destination",
    ]).has(value)) return "artifact-path-if-explicit";
  }
  if (/^python(?:\d+(?:\.\d+)*)?(?:[-.]\d.*)?$/u.test(runtimeBase)) {
    if (new Set([
      "-W",
      "-X",
      "--check-hash-based-pycs",
    ]).has(value)) return "scalar";
  }
  return null;
}

export function localReleaseArtifactManifestPolicy(context, profile) {
  const target = profile.local_release_target;
  const governanceRoot = path.resolve(context.sdlcRoot);
  for (const targetPath of target.allowed_write_paths) {
    const resolved = path.resolve(targetPath);
    if (isInsidePath(resolved, governanceRoot) || isInsidePath(governanceRoot, resolved)) {
      fail(
        `Local release artifact path ${resolved} overlaps governed .sdlc records. `
        + "Choose a narrower release directory outside .sdlc.",
      );
    }
  }
  const sortedPaths = [...target.allowed_write_paths].map((item) => path.resolve(item)).sort();
  for (let index = 0; index < sortedPaths.length; index += 1) {
    for (let candidate = index + 1; candidate < sortedPaths.length; candidate += 1) {
      if (isInsidePath(sortedPaths[index], sortedPaths[candidate])) {
        fail(
          `Local release artifact paths must not overlap: ${sortedPaths[index]} and ${sortedPaths[candidate]}.`,
        );
      }
    }
  }
  const subject = {
    schema_version: "local-release-artifact-manifest-policy:v1",
    root_path: path.resolve(target.root_path),
    smoke_cwd: governedLocalSmokeCwd(profile).smokeCwd,
    allowed_write_paths: sortedPaths,
    symlinks: "rejected",
    special_files: "rejected",
    maximum_entries_per_path: 10_000,
    maximum_bytes_per_path: 512 * 1024 * 1024,
    snapshot_passes: 2,
    hash_algorithm: "sha256:stable-json:v1",
  };
  return {
    ...subject,
    policy_hash: computeStableHash(subject),
  };
}

export function localReleaseTargetEntryPaths(profile) {
  const target = profile.local_release_target || {};
  return [
    path.resolve(String(target.root_path || "")),
    ...(target.allowed_write_paths || []).map((item) => path.resolve(String(item))),
  ];
}

export function localReleaseTargetEntryState(snapshot) {
  return (snapshot?.entries || []).map((entry) => ({ ...entry }));
}

export function localReleaseTargetHadAbsentEntries(snapshot) {
  return (snapshot?.entries || []).some((entry) => entry?.status === "absent");
}

export function localReleaseTargetHadOnlyDirectories(snapshot) {
  return (
    Array.isArray(snapshot?.entries)
    && snapshot.entries.length > 0
    && snapshot.entries.every((entry) => entry?.status === "directory")
  );
}

export function localReleaseTargetStateMatches(left, right) {
  return stableJson(localReleaseTargetEntryState(left))
    === stableJson(localReleaseTargetEntryState(right));
}

export function localReleaseBoundaryCheckpointFromSource(source) {
  return (
    source.writes_outside_workspace_require_checkpoint === true
    && source.target_outside_workspace === true
  ) || (
    source.machine_global_changes_require_checkpoint === true
    && source.target_machine_global === true
  );
}

export function localReleaseRuntimeBoundaryProjection(source) {
  if (!source || typeof source !== "object" || Array.isArray(source)) return null;
  return {
    schema_version: source.schema_version,
    target_hash: source.target_hash,
    platform: source.platform,
    workspace_real_path: source.workspace_real_path,
    target_real_path: source.target_real_path,
    global_roots: Array.isArray(source.global_roots) ? [...source.global_roots] : source.global_roots,
    target_outside_workspace: source.target_outside_workspace,
    target_machine_global: source.target_machine_global,
  };
}

export function localDeliveryRuntimeBoundaryChanged(authorizedSnapshot, currentSnapshot) {
  if (
    authorizedSnapshot?.delivery_kind !== "local_release"
    || currentSnapshot?.delivery_kind !== "local_release"
    || authorizedSnapshot?.action !== currentSnapshot?.action
    || !authorizedSnapshot?.local_boundary_source
    || !currentSnapshot?.local_boundary_source
  ) {
    return false;
  }
  return stableJson(localReleaseRuntimeBoundaryProjection(authorizedSnapshot.local_boundary_source))
    !== stableJson(localReleaseRuntimeBoundaryProjection(currentSnapshot.local_boundary_source));
}

export function normalizeGitRepositoryIdentity(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  let host = null;
  let repositoryPath = raw;
  const scpMatch = raw.match(/^[^/@\s]+@([^:/\s]+):(.+)$/u);
  if (scpMatch) {
    host = scpMatch[1];
    repositoryPath = scpMatch[2];
  } else if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(raw)) {
    try {
      const parsed = new URL(raw);
      host = parsed.hostname;
      repositoryPath = parsed.pathname;
    } catch {
      return null;
    }
  }
  repositoryPath = repositoryPath
    .replace(/^\/+|\/+$/gu, "")
    .replace(/\.git$/iu, "")
    .toLowerCase();
  const segments = repositoryPath.split("/").filter(Boolean);
  if (!host && segments.length === 2) host = "github.com";
  if (!host && segments.length >= 3 && segments[0].includes(".")) {
    host = segments.shift();
    repositoryPath = segments.join("/");
  }
  return host && repositoryPath.includes("/")
    ? `${String(host).toLowerCase()}/${repositoryPath}`
    : null;
}

export function deliveryMaterialScope(input) {
  const { profileId, deliveryId, deliveryKind, requirementProfiles, story, contract, target, constraints } = input;
  const releaseTarget = deliveryKind === "pull_request"
    ? target.pull_request_target
    : target.local_release_target;
  return {
    objective: contract.purpose || story.title,
    scope: {
      delivery_profile_id: profileId,
      delivery_id: deliveryId,
      story_id: story.id,
      contract_id: contract.id,
      requirement_profile_ids: requirementProfiles.map((profile) => profile.id).sort(),
    },
    acceptance_criteria: storyAcceptanceCriteria(story),
    environment: deliveryKind === "local_release" ? ["local"] : ["pull_request"],
    write_paths: deliveryKind === "local_release"
      ? target.local_release_target.allowed_write_paths
      : constraints.allowed_write_paths,
    capabilities: constraints.allowed_capabilities,
    budget: constraints.budget_ref,
    release_target: releaseTarget,
    external_or_production_access: {
      external: false,
      production: false,
      destructive: false,
    },
  };
}

export function deliveryEnvironmentBoundary(profile) {
  const targetBound = profile.delivery_kind === "local_release"
    ? Boolean(profile.local_release_target?.root_path)
    : Boolean(
        profile.pull_request_target?.repository
        && profile.pull_request_target?.base_branch
        && profile.pull_request_target?.head_branch,
      );
  return {
    max_level: targetBound ? profile.requested_level : "supervised",
    allowed: targetBound,
    status: targetBound ? "target_bound" : "unavailable",
  };
}

export function deliveryBudgetBoundary(current, requestedLevel) {
  const refs = [
    current.contract.execution_budget_ref,
    ...current.requirementProfiles.map((profile) => profile.constraints?.budget_ref || null),
  ].filter(Boolean);
  // The generic delivery path can bind a budget reference, but it does not yet
  // have a provider-neutral metering receipt. Never describe that boundary as
  // "available" or grant unattended execution from an unverified assumption.
  return {
    max_level: "checkpointed",
    allowed_to_start_next: true,
    status: refs.length > 0 ? "configured_unmetered" : "not_configured",
    requested_level: requestedLevel,
  };
}

export function deliveryTargetAllowedActions(profile) {
  return profile.delivery_kind === "pull_request"
    ? profile.pull_request_target?.allowed_actions || []
    : profile.local_release_target?.allowed_actions || [];
}

export function deliveryBoundaryCheckpointActions(profile) {
  if (profile.delivery_kind !== "local_release") {
    return [...DELIVERY_BOUNDARY_CHECKPOINT_ACTIONS];
  }
  return [
    ...DELIVERY_BOUNDARY_CHECKPOINT_ACTIONS,
    ...(profile.local_release_target?.data_migration ? REVERSIBLE_DATA_ACTIONS : []),
    ...(profile.local_release_target?.rollback?.verification_required === true
      ? ROLLBACK_VERIFICATION_ACTIONS
      : []),
  ].sort();
}

export function deliveryCheckpointPolicySourcesRoot(context) {
  return path.join(context.sdlcRoot, "autonomy", "policy-sources");
}

export function buildDeliveryCheckpointPolicySource(context) {
  const effectiveConfig = structuredClone(context.config);
  const effectiveConfigHash = hashApprovalSubject(effectiveConfig);
  if (effectiveConfigHash !== context.configState.effective_config_hash) {
    fail("Effective configuration changed while preparing the delivery checkpoint policy source.");
  }
  const sourceBase = {
    kind: "delivery_checkpoint_policy_source",
    schema_version: "delivery-checkpoint-policy-source:v1",
    config: {
      status: context.configState.status,
      path: context.configState.config_path || `${SDLC_DIR}/${PROJECT_CONFIG_FILE_NAME}`,
      raw_hash: context.configState.raw_config_hash || null,
      effective_hash: effectiveConfigHash,
      defaults_profile: context.configState.defaults_profile
        ? structuredClone(context.configState.defaults_profile)
        : null,
      inherited_paths: [...(context.configState.inherited_paths || [])],
    },
    effective_config: effectiveConfig,
  };
  const source = {
    ...sourceBase,
    source_hash: hashApprovalSubject(sourceBase),
    hash_algorithm: "sha256:stable-json:v1",
  };
  const sourcePath = path.join(deliveryCheckpointPolicySourcesRoot(context), `${source.source_hash}.json`);
  return {
    source,
    sourcePath,
    ref: {
      path: toProjectPath(context, sourcePath),
      hash: source.source_hash,
      effective_config_hash: effectiveConfigHash,
    },
  };
}

export function validateDeliveryCheckpointPolicySource(context, source, expectedRef = null) {
  const errors = [];
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    return { valid: false, errors: ["checkpoint policy source is not an object"] };
  }
  if (source.kind !== "delivery_checkpoint_policy_source") {
    errors.push("checkpoint policy source kind is invalid");
  }
  if (source.schema_version !== "delivery-checkpoint-policy-source:v1") {
    errors.push("checkpoint policy source schema version is unsupported");
  }
  if (source.hash_algorithm !== "sha256:stable-json:v1") {
    errors.push("checkpoint policy source hash algorithm is invalid");
  }
  const { source_hash: storedHash, hash_algorithm: _hashAlgorithm, ...sourceBase } = source;
  const expectedSourceHash = hashApprovalSubject(sourceBase);
  if (storedHash !== expectedSourceHash) {
    errors.push("checkpoint policy source hash is invalid");
  }
  const effectiveConfigHash = source.effective_config
    && typeof source.effective_config === "object"
    && !Array.isArray(source.effective_config)
    ? hashApprovalSubject(source.effective_config)
    : null;
  if (!effectiveConfigHash || source.config?.effective_hash !== effectiveConfigHash) {
    errors.push("checkpoint policy source does not reproduce its effective config hash");
  }
  if (
    !source.config
    || typeof source.config !== "object"
    || Array.isArray(source.config)
    || typeof source.config.path !== "string"
    || source.config.path.length === 0
    || !Array.isArray(source.config.inherited_paths)
    || stableJson(source.config.inherited_paths) !== stableJson([...new Set(source.config.inherited_paths)].sort())
  ) {
    errors.push("checkpoint policy source config identity is invalid");
  }
  const defaultsProfile = source.config?.defaults_profile;
  if (defaultsProfile !== null && (
    !defaultsProfile
    || typeof defaultsProfile !== "object"
    || Array.isArray(defaultsProfile)
    || typeof defaultsProfile.id !== "string"
    || defaultsProfile.id.length === 0
    || !/^[a-f0-9]{64}$/u.test(defaultsProfile.sha256 || "")
  )) {
    errors.push("checkpoint policy source defaults profile is invalid");
  }
  if (expectedRef && (
    expectedRef.hash !== storedHash
    || expectedRef.effective_config_hash !== effectiveConfigHash
  )) {
    errors.push("checkpoint policy source reference is stale");
  }
  return { valid: errors.length === 0, errors, effectiveConfigHash };
}

export function deliveryActionCheckpointPolicySnapshot(
  context,
  profile,
  effectiveLevel,
  action,
  actionPolicy,
  policySourceRef = buildDeliveryCheckpointPolicySource(context).ref,
) {
  const snapshot = {
    schema_version: "delivery-action-checkpoint-policy:v1",
    action,
    delivery_kind: profile.delivery_kind,
    effective_level: effectiveLevel,
    profile_ref: { id: profile.id, hash: profile.profile_hash },
    preset_checkpoints: actionPolicy.preset_checkpoints,
    policy_source_ref: policySourceRef,
    profile_checkpoints: actionPolicy.profile_checkpoints,
    boundary_actions: actionPolicy.boundary_actions,
    local_boundary_checkpoint: actionPolicy.local_boundary_checkpoint,
    local_boundary_source: actionPolicy.local_boundary_source,
    local_boundary_source_hash: actionPolicy.local_boundary_source
      ? hashApprovalSubject(actionPolicy.local_boundary_source)
      : null,
    required: actionPolicy.required,
  };
  return { ...snapshot, policy_hash: hashApprovalSubject(snapshot) };
}

export function compareDeliveryAuthorizationOrder(left, right) {
  return String(left.authorized_at).localeCompare(String(right.authorized_at))
    || String(left.id).localeCompare(String(right.id));
}

export function deliveryActionAuthorizationRequestHash(options = {}) {
  const ignored = new Set(["full", "json", "locale"]);
  const request = {};
  for (const key of Object.keys(options).sort()) {
    if (ignored.has(key) || options[key] === undefined) continue;
    request[key] = Array.isArray(options[key]) ? [...options[key]] : options[key];
  }
  return hashApprovalSubject(request);
}

export function deliveryActionAuthorizationIntentIdentity(context, profile, action, options = {}) {
  if (getOptionString(options, "approval-source") !== "automation") {
    return null;
  }
  const authorizationOption = getOptionString(options, "authorization");
  if (!authorizationOption) {
    return null;
  }
  const authorizationId = normalizeId(authorizationOption);
  const requestHash = deliveryActionAuthorizationRequestHash(options);
  const transactionKey = shortHashFull(stableJson({
    profile_id: profile.id,
    profile_hash: profile.profile_hash,
    action,
    authorization_id: authorizationId,
    request_hash: requestHash,
  }));
  const id = `AUT-INT-${transactionKey}`;
  return {
    id,
    transactionKey,
    authorizationId,
    profileId: profile.id,
    profileHash: profile.profile_hash,
    action,
    requestHash,
    path: path.join(autonomyActionIntentsRoot(context), `${id}.json`),
  };
}

export function deliveryActionIntentUseReceiptId(identity) {
  return `AUSE-${identity.authorizationId}-${identity.transactionKey.slice(0, 24)}`;
}

export function deliveryActionApprovalRecoveryProjection(approval = {}) {
  return {
    status: approval.status,
    summary: approval.summary,
    scope: approval.scope,
    evidence: approval.evidence,
    approval_source: approval.approval_source,
    authorization_ref: approval.authorization_ref,
    authorization_use_ref: approval.authorization_use_ref,
    authorization_action: approval.authorization_action,
    explicit_user_confirmation: approval.explicit_user_confirmation,
    provisional: approval.provisional,
    approved_content_hash: approval.approved_content_hash,
    hash_algorithm: approval.hash_algorithm,
    approved_by: approval.approved_by,
    authority_assurance: approval.authority_assurance,
  };
}

export function deliveryActionReceiptRef(context, receipt) {
  return {
    id: receipt.id,
    path: toProjectPath(
      context,
      path.join(autonomyActionsRoot(context), `${normalizeId(receipt.id)}.json`),
    ),
    hash: receipt.receipt_hash,
  };
}

export function deliveryActionAttemptReceiptRef(context, profile, receipt) {
  return {
    id: receipt.id,
    path: toProjectPath(
      context,
      deliveryActionAttemptPath(context, profile.id, receipt.id),
    ),
    hash: receipt.receipt_hash,
  };
}

export function deliveryStartReceiptRef(context, profile, receipt) {
  return {
    id: receipt.id,
    path: toProjectPath(context, deliveryStartReceiptPath(context, profile.id)),
    hash: receipt.receipt_hash,
  };
}

export function terminalStatusForDeliveryAction(action) {
  return action === "pull_request.merge"
    ? "merged"
    : action === "release.local"
      ? "released"
      : null;
}

export function canonicalDeliveryCompletionEvidence(evidence = []) {
  return [...evidence]
    .map((item) => ({ path: item.path, sha256: item.sha256 }))
    .sort((left, right) => (
      left.path.localeCompare(right.path)
      || left.sha256.localeCompare(right.sha256)
    ));
}

export function deliveryCompletionOperationArgs(profile, action, options = {}) {
  const operationArgs = {};
  const scopePaths = normalizeRawListOption(options["scope-path"])
    .map((item) => String(item).replace(/\\/gu, "/"))
    .sort();
  if (scopePaths.length > 0) {
    operationArgs.scope_paths = scopePaths;
  }
  if (action === "git.push") {
    operationArgs.remote = getOptionString(options, "remote") || null;
  }
  if (["pull_request.create", "pull_request.update", "pull_request.merge"].includes(action)) {
    operationArgs.pr_url = getOptionString(options, "pr-url") || null;
    operationArgs.expected_pr_title = getOptionString(options, "expected-pr-title") || null;
    operationArgs.expected_pr_body_sha256 = getOptionString(options, "expected-pr-body-sha256") || null;
    operationArgs.expected_pr_state = getOptionString(options, "expected-pr-state") || null;
    operationArgs.expected_pr_base = getOptionString(options, "expected-pr-base") || null;
  }
  if (action === "release.local") {
    const smokeCwdOption = getOptionString(options, "smoke-cwd");
    operationArgs.smoke_cwd = smokeCwdOption
      ? path.isAbsolute(smokeCwdOption)
        ? path.resolve(smokeCwdOption)
        : path.resolve(profile.local_release_target.root_path, smokeCwdOption)
      : governedLocalSmokeCwd(profile).smokeCwd;
    operationArgs.smoke_tests = normalizeListOption(options["smoke-test"])
      .map(normalizeSmokeTestCommand)
      .sort();
    operationArgs.rollback = getOptionString(options, "rollback") || null;
  }
  return operationArgs;
}

export function buildDeliveryCompletionRequest(
  context,
  profile,
  action,
  outcome,
  evidence,
  options,
  authorization,
) {
  const requestBase = {
    schema_version: "delivery-action-completion-request:v1",
    profile_ref: {
      id: profile.id,
      path: toProjectPath(context, deliveryAutonomyPath(context, profile.id)),
      hash: profile.profile_hash,
    },
    action,
    outcome,
    authorization_receipt_ref: deliveryActionReceiptRef(context, authorization),
    evidence: canonicalDeliveryCompletionEvidence(evidence),
    operation_args: deliveryCompletionOperationArgs(profile, action, options),
  };
  return {
    ...requestBase,
    request_hash: hashApprovalSubject(requestBase),
    hash_algorithm: "sha256:stable-json:v1",
  };
}

export function localReleaseAttemptId(authorization, completionRequest) {
  const identityHash = shortHashFull(stableJson({
    authorization_id: authorization.id,
    authorization_hash: authorization.receipt_hash,
    completion_request_hash: completionRequest.request_hash,
  }));
  return `AUT-TRY-${identityHash.slice(0, 32)}`;
}

export function localReleaseAttemptReceiptErrors(context, profile, attempt, authorization) {
  const errors = [];
  if (
    attempt.profile_ref?.id !== profile.id
    || attempt.profile_ref?.path !== toProjectPath(context, deliveryAutonomyPath(context, profile.id))
    || attempt.profile_ref?.hash !== profile.profile_hash
    || attempt.delivery?.id !== profile.delivery_id
    || attempt.delivery?.kind !== "local_release"
    || attempt.action !== "release.local"
  ) {
    errors.push("attempt does not bind the exact local delivery profile");
  }
  if (
    !authorization
    || authorization.status !== "authorized"
    || authorization.action !== "release.local"
    || stableJson(attempt.authorization_receipt_ref)
      !== stableJson(deliveryActionReceiptRef(context, authorization))
  ) {
    errors.push("attempt does not reference its exact release.local authorization");
    return errors;
  }
  if (attempt.id !== localReleaseAttemptId(authorization, attempt.completion_request)) {
    errors.push("attempt id is not the deterministic identity of its authorization and request");
  }
  const authorizedAt = Date.parse(authorization.authorized_at || "");
  const startedAt = Date.parse(attempt.started_at || "");
  if (
    !Number.isFinite(authorizedAt)
    || !Number.isFinite(startedAt)
    || startedAt < authorizedAt
  ) {
    errors.push("attempt start time predates or cannot be ordered after authorization");
  }
  const pseudoCompletion = {
    profile_ref: attempt.profile_ref,
    action: attempt.action,
    outcome: "passed",
    authorization_receipt_ref: attempt.authorization_receipt_ref,
    evidence: attempt.completion_request?.evidence || [],
    completion_request: attempt.completion_request,
  };
  const requestValidation = validateDeliveryCompletionRequest(
    context,
    pseudoCompletion,
    authorization,
  );
  if (!requestValidation.valid) {
    errors.push(`attempt completion request is invalid: ${requestValidation.errors.join("; ")}`);
  }
  const authorizedIntegrity = authorization.action_details?.local_release_integrity;
  if (
    !authorizedIntegrity
    || authorizedIntegrity.schema_version !== "local-release-integrity:v2"
    || authorizedIntegrity.smoke_execution_policy?.schema_version
      !== "local-smoke-sandbox-policy:v2"
    || !hashBoundRecordIsValid(authorizedIntegrity, "integrity_hash")
    || !hashBoundRecordIsValid(authorizedIntegrity.smoke_execution_policy, "policy_hash")
    || !hashBoundRecordIsValid(authorizedIntegrity.artifact_manifest_policy, "policy_hash")
  ) {
    errors.push("attempt authorization lacks a valid local-release integrity policy");
    return errors;
  }
  if (
    attempt.smoke_execution_policy_ref?.policy_hash
      !== authorizedIntegrity.smoke_execution_policy.policy_hash
  ) {
    errors.push("attempt references a different smoke execution policy");
  }
  if (
    !hashBoundRecordIsValid(attempt.artifact_before_smoke, "manifest_hash")
    || stableJson(attempt.artifact_before_smoke?.policy)
      !== stableJson(authorizedIntegrity.artifact_manifest_policy)
  ) {
    errors.push("attempt pre-smoke artifact manifest is invalid or uses another policy");
  }
  const expectedOperation = {
    smoke_cwd: governedLocalSmokeCwd(profile).smokeCwd,
    smoke_tests: [...(profile.local_release_target?.smoke_tests || [])].sort(),
    rollback: profile.local_release_target?.rollback?.procedure || null,
  };
  const recordedOperation = attempt.completion_request?.operation_args || {};
  if (
    recordedOperation.smoke_cwd !== expectedOperation.smoke_cwd
    || stableJson(recordedOperation.smoke_tests) !== stableJson(expectedOperation.smoke_tests)
    || recordedOperation.rollback !== expectedOperation.rollback
  ) {
    errors.push("attempt operation differs from the exact approved smoke target, commands, or rollback");
  }
  return errors;
}

export function validateDeliveryCompletionRequest(context, receipt, authorization) {
  const request = receipt?.completion_request;
  if (!request) {
    const legacy = receipt?.schema_version === "delivery-action-receipt:v1";
    return {
      valid: false,
      legacy,
      errors: legacy
        ? []
        : [`${receipt?.schema_version || "current delivery action receipt"} completion requires a completion request`],
    };
  }
  const {
    request_hash: requestHash,
    hash_algorithm: hashAlgorithm,
    ...requestBase
  } = request;
  const errors = [];
  if (request.schema_version !== "delivery-action-completion-request:v1") {
    errors.push("completion request schema version is unsupported");
  }
  if (hashAlgorithm !== "sha256:stable-json:v1") {
    errors.push("completion request hash algorithm is invalid");
  }
  if (requestHash !== hashApprovalSubject(requestBase)) {
    errors.push("completion request hash is invalid");
  }
  if (
    stableJson(request.profile_ref) !== stableJson(receipt.profile_ref)
    || request.action !== receipt.action
    || request.outcome !== receipt.outcome
    || stableJson(request.authorization_receipt_ref)
      !== stableJson(receipt.authorization_receipt_ref)
    || stableJson(request.authorization_receipt_ref)
      !== stableJson(deliveryActionReceiptRef(context, authorization))
    || stableJson(request.evidence)
      !== stableJson(canonicalDeliveryCompletionEvidence(receipt.evidence))
    || !request.operation_args
    || typeof request.operation_args !== "object"
    || Array.isArray(request.operation_args)
  ) {
    errors.push("completion request differs from its persisted action receipt");
  }
  return { valid: errors.length === 0, legacy: false, errors };
}

export function buildDeliveryActionCompletionTraceEvent(context, profile, receipt) {
  const requestHash = receipt.completion_request?.request_hash || receipt.receipt_hash;
  return {
    id: `TR-COMP-${normalizeId(receipt.id)}`,
    story_id: profile.story_refs[0]?.id || null,
    type: receipt.action === "release.local" ? "release" : "gate",
    summary: `Completed ${receipt.action} for exact delivery ${profile.delivery_id}`,
    outcome: receipt.outcome,
    actor: receipt.authorized_by,
    requested_by: null,
    authorized_by: null,
    request: null,
    authorization_ref: null,
    action: receipt.action,
    evidence: [
      toProjectPath(
        context,
        path.join(autonomyActionsRoot(context), `${normalizeId(receipt.id)}.json`),
      ),
      ...(receipt.evidence || []).map((item) => item.path),
    ],
    related: [profile.id, profile.delivery_id],
    git: receipt.audit?.git || {},
    run: receipt.audit?.run || {},
    correlation_id: `completion-${requestHash}`,
    created_at: receipt.authorized_at,
  };
}

export function buildTerminalDeliveryCloseTraceEvent(context, profile, closeReceipt, completion) {
  return {
    id: `TR-CLOSE-${normalizeId(closeReceipt.id)}`,
    story_id: profile.story_refs[0]?.id || null,
    type: "gate",
    summary: `Closed ${profile.delivery_kind} ${profile.delivery_id} from passing ${completion.action} receipt`,
    outcome: "passed",
    actor: closeReceipt.closed_by,
    requested_by: null,
    authorized_by: null,
    request: null,
    authorization_ref: null,
    action: "autonomy.delivery.close.terminal-action",
    evidence: [
      toProjectPath(
        context,
        path.join(autonomyActionsRoot(context), `${normalizeId(completion.id)}.json`),
      ),
      toProjectPath(context, deliveryCloseReceiptPath(context, profile.id)),
    ],
    related: [profile.id, profile.delivery_id, completion.id],
    git: closeReceipt.audit?.git || {},
    run: closeReceipt.audit?.run || {},
    correlation_id: `close-${completion.receipt_hash}`,
    created_at: closeReceipt.closed_at,
  };
}

export function releaseManifestPath(context, id) {
  const root = configuredSdlcDirectory(
    context,
    context.config.release_evidence_policy?.manifest_directory,
    "releases/manifests",
    "release_evidence_policy.manifest_directory",
  );
  return path.join(root, `${normalizeId(id)}.json`);
}

export function releaseGateReceiptsRoot(context) {
  return configuredSdlcDirectory(
    context,
    context.config.release_evidence_policy?.gate_receipt_directory,
    "releases/gates",
    "release_evidence_policy.gate_receipt_directory",
  );
}

export function releaseGateReceiptPath(context, id) {
  return path.join(releaseGateReceiptsRoot(context), `${normalizeId(id)}.json`);
}

export function buildReleaseGateReceipt(context, input) {
  const receipt = {
    kind: "release_gate_receipt",
    schema_version: "release-gate-receipt:v1",
    version: 1,
    id: normalizeId(input.id),
    status: "passed",
    scope: {
      manifest_id: normalizeId(input.manifest_id),
      proposal_ref: input.proposal_ref,
    },
    checks: input.checks.map((check) => ({
      name: check.name,
      status: "passed",
      subject_hash: shortHashFull(stableJson(check.subject ?? check.evidence ?? [])),
      evidence: Array.from(
        new Map((check.evidence || []).map((reference) => [stableJson(reference), reference])).values(),
      ),
    })),
    generated_at: input.generated_at,
    actor: input.actor,
    audit: input.audit,
  };
  receipt.receipt_hash = shortHashFull(stableJson(receipt));
  receipt.hash_algorithm = "sha256:stable-json:v1";
  return receipt;
}

export function normalizeDeliveryFormatOptions(options = []) {
  const rawOptions = Array.isArray(options) ? options : [];
  return rawOptions
    .map((option) => {
      if (typeof option === "string") {
        const label = option.trim();
        return label ? { id: slugify(label), label, description: null } : null;
      }
      if (!option || typeof option !== "object") {
        return null;
      }
      const label = String(option.label || option.id || "").trim();
      const id = slugify(option.id || label);
      if (!id || !label) {
        return null;
      }
      return {
        id,
        label,
        description: option.description ? String(option.description).trim() : null,
        when_to_use: option.when_to_use ? String(option.when_to_use).trim() : null,
      };
    })
    .filter(Boolean);
}

export function formatDeliveryFormatOption(option) {
  return [
    option.label,
    option.description ? ` - ${option.description}` : null,
    option.when_to_use ? ` Use when: ${option.when_to_use}` : null,
  ].filter(Boolean).join("");
}

export function dedupeDeliveryFormatOptions(options) {
  const seen = new Set();
  const result = [];
  for (const option of normalizeDeliveryFormatOptions(options)) {
    if (seen.has(option.id)) {
      continue;
    }
    seen.add(option.id);
    result.push(option);
  }
  return result;
}

export function recommendedDeliveryFormatForOutput(artifactType = "", phase = null) {
  const normalized = String(artifactType || phase || "").toLowerCase();
  if (matchesAny(normalized, ["implementation", "code", "patch", "change"])) {
    return "changed-files-summary + modified-classes-components + tests-and-verification; include diff-review or key-code-snippets only when the user asks for code-level review.";
  }
  if (matchesAny(normalized, ["validation", "test", "qa", "verification"])) {
    return "test-evidence + regression-risk-summary, with failure-triage when checks fail.";
  }
  if (matchesAny(normalized, ["release", "deploy", "deployment", "handoff"])) {
    return "release-notes + deployment-checklist + handoff-summary.";
  }
  if (matchesAny(normalized, ["design", "architecture", "api", "ux", "ui"])) {
    return "Project document plus chat summary, with design rationale and interface contracts when implementation will follow.";
  }
  return "Project document plus chat summary: save the result and provide a concise chat summary.";
}

export function contractDeliveryDescriptor(contract) {
  const outputTypes = Array.isArray(contract.output_contract_refs)
    ? contract.output_contract_refs.map((ref) => ref.artifact_type).filter(Boolean)
    : [];
  return [contract.phase, ...outputTypes].filter(Boolean).join(" ");
}

export function recommendedDeliveryFormatForContract(contract) {
  return recommendedDeliveryFormatForOutput(contractDeliveryDescriptor(contract), contract.phase);
}

export function formatOutputDeliveryForHuman(delivery) {
  return [
    `${delivery.label} (${delivery.extension})`,
    delivery.generator ? `created with the ${delivery.generator} artifact capability` : "created directly",
    delivery.mode === "artifact-plus-chat-summary" ? "plus a concise chat summary" : "as the canonical file",
  ].join(", ");
}

export function validateArtifactDeliveryPath(artifactPath, delivery, label = "Output") {
  if (!delivery.extension) {
    return;
  }
  if (!String(artifactPath).toLowerCase().endsWith(delivery.extension.toLowerCase())) {
    fail(`${label} requires a ${delivery.extension} canonical artifact, but received ${path.basename(artifactPath)}.`);
  }
}

/**
 * The phase whose completion closes a delivery. It is "release" whenever the
 * project's phase order has one, even when a later phase such as operations
 * follows it; a custom phase order without "release" keeps its last phase, as
 * before operations existed.
 */
export function releasePhaseName(context) {
  const phaseOrder = configuredPhaseOrder(context);
  return phaseOrder.includes("release") ? "release" : phaseOrder.at(-1);
}

export function deliveryActionEvidenceRevision(receipt) {
  const candidates = [
    receipt.action_details?.commit?.after_sha,
    receipt.action_details?.push?.source_sha,
    receipt.action_details?.merge?.source_sha,
    receipt.runtime_target?.head_sha,
  ];
  return candidates.find((candidate) => /^[a-f0-9]{40,64}$/u.test(candidate || "")) || null;
}

export function normalizeGitEvent(value) {
  const normalized = String(value || "").trim().toLowerCase();
  const allowed = ["push", "commit", "merge", "pull", "rebase", "branch", "handoff", "pr"];
  if (!allowed.includes(normalized)) {
    fail(`Unknown git event '${value}'. Valid values: ${allowed.join(", ")}`);
  }
  return normalized;
}
