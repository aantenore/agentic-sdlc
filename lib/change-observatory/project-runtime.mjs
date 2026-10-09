import path from "node:path";

import { fsPromises as fs } from "../runtime/host.mjs";
import { normalizeObservatoryLimits } from "./constants.mjs";
import {
  resolveObservatoryConfigurationRevision,
  resolveObservatoryConfigurationSnapshot,
} from "./configuration.mjs";
import { createObservatoryModelCache } from "./model-cache.mjs";
import { buildObservatoryViewModel } from "./normalizer.mjs";
import { buildProjectPortfolioSummary } from "./portfolio-project-summary.mjs";
import {
  ObservatoryPathError,
  assertDirectoryIdentity,
  captureDirectoryIdentity,
  resolveProjectBoundary,
} from "./path-safety.mjs";
import { readSourceRecord } from "./source-reader.mjs";
import { readTrackedSharedClaims } from "./shared-claims.mjs";
import { readDependencyEdges } from "./dependency-edges.mjs";
import { readRemoteOnlyStories } from "./remote-stories.mjs";
import { redactText } from "../observability/redaction.mjs";
import { DEFAULT_OPERATIONAL_REDACTION_POLICY } from "../observability/redaction.mjs";

export class ProjectDataRuntimeError extends Error {
  constructor(code, message, statusCode, retryable = undefined) {
    super(message);
    this.name = "ProjectDataRuntimeError";
    this.code = code;
    this.statusCode = statusCode;
    this.retryable = retryable;
  }
}

export async function createProjectDataRuntime(options = {}) {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("Project data runtime options must be an object");
  }
  const projectRoot = await resolveProjectBoundary(options.projectRoot);
  const projectIdentity = await captureDirectoryIdentity(projectRoot, {
    code: "project_boundary_changed",
    label: "project root",
  });
  const limits = normalizeObservatoryLimits(options.limits);
  let configurationError = null;
  let configurationRevision = null;
  let observabilityConfiguration;
  try {
    const snapshot = await resolveObservatoryConfigurationSnapshot(projectRoot, {
      redactionPolicy: options.redactionPolicy,
      operationalPolicy: options.operationalPolicy,
    });
    observabilityConfiguration = snapshot.configuration;
    configurationRevision = snapshot.revision;
  } catch (error) {
    if (!(error instanceof ObservatoryPathError) && !(error instanceof TypeError)) throw error;
    configurationError = await normalizeConfigurationBoundaryError(error, projectRoot);
    // This fallback is process-local only. Every project-data method remains
    // blocked by configurationError until the runtime is recreated.
    observabilityConfiguration = Object.freeze({
      redactionPolicy: DEFAULT_OPERATIONAL_REDACTION_POLICY,
      operationalPolicy: Object.freeze({}),
    });
  }

  const buildViewModel = options.buildViewModel ?? buildObservatoryViewModel;
  if (typeof buildViewModel !== "function") {
    throw new TypeError("Observatory buildViewModel must be a function");
  }
  const buildPortfolioSummary = options.buildPortfolioSummary ?? buildProjectPortfolioSummary;
  if (typeof buildPortfolioSummary !== "function") {
    throw new TypeError("Observatory buildPortfolioSummary must be a function");
  }
  const modelCache = createObservatoryModelCache({
    projectRoot,
    limits,
    buildModel: () => buildViewModel(projectRoot, {
      clock: options.clock,
      limits,
      redactionPolicy: observabilityConfiguration.redactionPolicy,
      summaryRanking: options.summaryRanking,
    }),
    onEvent: options.onCacheEvent,
  });

  async function assertConfigurationStable() {
    if (configurationError) throw configurationError;
    try {
      const currentRevision = await resolveObservatoryConfigurationRevision(projectRoot);
      if (currentRevision === configurationRevision) return;
      await resolveObservatoryConfigurationSnapshot(projectRoot, {
        redactionPolicy: options.redactionPolicy,
        operationalPolicy: options.operationalPolicy,
      });
      configurationError = new ProjectDataRuntimeError(
        "observability_configuration_changed",
        "Project observability configuration changed while Change Observatory was running. Restart it to apply the reviewed privacy settings safely.",
        503,
        false,
      );
      throw configurationError;
    } catch (error) {
      if (error === configurationError) throw error;
      configurationError = await normalizeRuntimeConfigurationError(error, projectRoot);
      throw configurationError;
    }
  }

  async function assertBoundary() {
    await assertDirectoryIdentity(projectIdentity);
  }

  async function getRepresentation() {
    await assertBoundary();
    await assertConfigurationStable();
    const representation = await modelCache.get();
    await assertConfigurationStable();
    await assertBoundary();
    return representation;
  }

  async function readSource(relativePath) {
    await assertBoundary();
    await assertConfigurationStable();
    const source = await readSourceRecord(projectRoot, relativePath, {
      limits,
      redactionPolicy: observabilityConfiguration.redactionPolicy,
    });
    await assertConfigurationStable();
    await assertBoundary();
    return source;
  }

  async function readSharedClaims() {
    await assertBoundary();
    await assertConfigurationStable();
    const claims = readTrackedSharedClaims(projectRoot);
    await assertBoundary();
    return claims;
  }

  async function readDependencies() {
    await assertBoundary();
    await assertConfigurationStable();
    const dependencies = await readDependencyEdges(projectRoot, {
      redactionPolicy: observabilityConfiguration.redactionPolicy,
    });
    await assertConfigurationStable();
    await assertBoundary();
    return dependencies;
  }

  async function readRemoteStories() {
    await assertBoundary();
    await assertConfigurationStable();
    const remote = readRemoteOnlyStories(projectRoot);
    await assertBoundary();
    const policy = observabilityConfiguration.redactionPolicy;
    return {
      ...remote,
      stories: remote.stories.map((story) => ({
        ...story,
        title: story.title === null ? null : redactText(story.title, policy),
      })),
    };
  }

  async function getPortfolioSummary() {
    await assertBoundary();
    await assertConfigurationStable();
    const summary = await buildPortfolioSummary(projectRoot, {
      clock: options.clock,
      limits,
      redactionPolicy: observabilityConfiguration.redactionPolicy,
    });
    await assertConfigurationStable();
    await assertBoundary();
    return summary;
  }

  return Object.freeze({
    projectRoot,
    configurationRevision,
    limits,
    redactionPolicy: observabilityConfiguration.redactionPolicy,
    operationalPolicy: observabilityConfiguration.operationalPolicy,
    assertBoundary,
    assertConfigurationStable,
    getRepresentation,
    getPortfolioSummary,
    readSource,
    readSharedClaims,
    readDependencies,
    readRemoteStories,
    async assertReady() {
      // Preserve the established readiness order: configuration, project
      // boundary, model, then both boundaries again before reporting ready.
      await assertConfigurationStable();
      await assertBoundary();
      await modelCache.get();
      await assertConfigurationStable();
      await assertBoundary();
    },
    clear() {
      modelCache.clear();
    },
    dispose() {
      modelCache.clear();
    },
  });
}

async function normalizeConfigurationBoundaryError(error, projectRoot) {
  if (error instanceof TypeError) {
    return new ProjectDataRuntimeError(
      "observability_configuration_invalid",
      "Project observability configuration is invalid. Correct .sdlc/config.json and retry.",
      503,
      false,
    );
  }
  if (!(error instanceof ObservatoryPathError) || error.code !== "symlink_forbidden") {
    return error;
  }
  try {
    const knowledgeBase = await fs.lstat(path.join(projectRoot, ".sdlc"));
    if (knowledgeBase.isSymbolicLink()) {
      return new ObservatoryPathError(
        "knowledge_base_symlink",
        "The project knowledge base must be a canonical directory, not a symlink",
        403,
      );
    }
  } catch {
    // Keep the original safe boundary error when the parent cannot be inspected.
  }
  return error;
}

async function normalizeRuntimeConfigurationError(error, projectRoot) {
  if (error instanceof TypeError || error instanceof ObservatoryPathError) {
    return normalizeConfigurationBoundaryError(error, projectRoot);
  }
  return new ProjectDataRuntimeError(
    "observability_configuration_unavailable",
    "Project observability configuration could not be checked safely. Fix the configuration boundary and restart Change Observatory.",
    503,
    false,
  );
}
