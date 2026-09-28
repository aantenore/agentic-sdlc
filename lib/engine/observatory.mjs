import path from "node:path";
import {
  ObservatoryPathError,
} from "../change-observatory/path-safety.mjs";
import {
  createPortfolioRuntime,
} from "../change-observatory/portfolio-runtime.mjs";
import {
  fail,
  failUsage,
} from "../cli/user-error.mjs";
import {
  validateContextOptimizationLineage,
  validateContextOptimizationObservation,
} from "../context-optimization.mjs";
import {
  createDefaultDeliveryProviderRegistry,
} from "../delivery/default-providers.mjs";
import {
  DeliveryProviderError,
  assertProviderOperationReceiptIntegrity,
} from "../delivery/provider-registry.mjs";
import {
  getOptionString,
} from "../lifecycle/common.mjs";
import {
  deliveryProviderOperationSubject,
  resolveDeliveryProviderBinding,
} from "../lifecycle/delivery.mjs";
import {
  contextOptimizationObservationsRoot,
  toProjectPath,
} from "../lifecycle/project.mjs";
import {
  console,
  process,
} from "../runtime/host.mjs";
import {
  assertRecordSchema,
} from "./common.mjs";
import {
  readProjectJson,
  safeReadDir,
} from "./storage.mjs";

export async function runPortfolioStatusFromCli({ options, resolution }) {
  if (resolution.args.length > 0) {
    failUsage(`Unknown command: ${resolution.input.slice(0, 3).join(" ")}`);
  }
  const manifestPath = getOptionString(options, "manifest");
  if (!manifestPath) fail("portfolio status needs --manifest with one explicit relative JSON path");
  let runtime;
  try {
    runtime = await createPortfolioRuntime({
      portfolioRoot: path.resolve(String(options.root || process.cwd())),
      manifestPath,
    });
    const representation = await runtime.getSummaryRepresentation();
    const summary = JSON.parse(representation.body.toString("utf8"));
    if (options.json === true) {
      console.log(JSON.stringify({
        schema_version: "agentic-sdlc:portfolio-status:v1",
        status: summary.status,
        health: summary.health,
        generated_at: summary.generatedAt,
        project_count: summary.projectCount,
        available_project_count: summary.availableProjectCount,
        unavailable_project_count: summary.unavailableProjectCount,
        needs_attention_project_count: summary.needsAttentionProjectCount,
        review_project_count: summary.reviewProjectCount,
        aggregates: summary.aggregates,
        projects: summary.projects,
      }));
      return;
    }
    console.log(`Portfolio: ${summary.health} (${summary.availableProjectCount}/${summary.projectCount} projects available)`);
    for (const project of summary.projects) {
      console.log(`- ${project.id}: ${project.health}`);
    }
  } catch (error) {
    if (error instanceof TypeError) fail(error.message);
    if (error instanceof ObservatoryPathError) {
      fail(`The portfolio status could not be read safely: ${error.message}`);
    }
    throw error;
  } finally {
    await runtime?.dispose().catch(() => {});
  }
}

export function readContextOptimizationObservations(context, proposalId) {
  const observations = safeReadDir(contextOptimizationObservationsRoot(context, proposalId))
    .filter((name) => name.endsWith(".json"))
    .map((name) => ({
      filePath: path.join(contextOptimizationObservationsRoot(context, proposalId), name),
    }))
    .map((item) => ({ ...item, observation: readProjectJson(context, item.filePath) }))
    .map((item) => {
      const validation = validateContextOptimizationObservation(item.observation);
      if (!validation.valid) {
        fail(`Context optimization observation ${toProjectPath(context, item.filePath)} is invalid: ${validation.errors.join("; ")}`);
      }
      assertRecordSchema(item.observation, "context-optimization-observation.schema.json", `Context optimization observation ${item.observation.id}`);
      return item;
    });
  const lineage = validateContextOptimizationLineage(observations.map((item) => item.observation));
  if (!lineage.valid) {
    fail(`Context optimization lineage for ${proposalId} is invalid: ${lineage.errors.join("; ")}`);
  }
  const byHash = new Map(observations.map((item) => [item.observation.observation_hash, item]));
  return lineage.ordered.map((observation) => byHash.get(observation.observation_hash));
}

export function observeDeliveryProviderPrecondition(context, profile, action, actionDetails, operationId, authorizedAt) {
  const binding = resolveDeliveryProviderBinding(profile, action);
  if (!binding) return null;
  const registry = createDefaultDeliveryProviderRegistry();
  const subject = deliveryProviderOperationSubject(context, profile, action, actionDetails, authorizedAt);
  try {
    const receipt = registry.observePrecondition(binding.provider_id, {
      id: operationId,
      action,
      subject,
      observed_at: authorizedAt,
    }, { cwd: context.root });
    assertProviderOperationReceiptIntegrity(receipt);
    assertRecordSchema(receipt, "provider-operation-receipt.schema.json", `${action} provider precondition`);
    return {
      binding: {
        action,
        provider_id: binding.provider_id,
        source: binding.derived_only ? "legacy-v1" : "explicit-v2",
        provider_bindings_hash: profile.provider_bindings_hash || null,
      },
      precondition_receipt: receipt,
      completion_receipt: null,
    };
  } catch (error) {
    if (error instanceof DeliveryProviderError) {
      fail(`Could not verify the safe starting state for ${action}. ${error.message}`);
    }
    throw error;
  }
}
