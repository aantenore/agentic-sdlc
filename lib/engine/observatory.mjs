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
  const failOnAttention = options["fail-on-attention"] === true;
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
        fail_on_attention: failOnAttention,
        projects: summary.projects.map((project) => ({
          ...project,
          attention_reason: portfolioAttentionReason(project),
        })),
      }));
    } else {
      console.log(`Portfolio: ${summary.health} (${summary.availableProjectCount}/${summary.projectCount} projects available)`);
      for (const project of summary.projects) {
        const reason = portfolioAttentionReason(project);
        console.log(`- ${project.id}: ${project.health}${reason ? ` (${reason})` : ""}`);
      }
    }
    if (failOnAttention && summary.projects.some(portfolioProjectNeedsAttention)) {
      process.exitCode = 1;
      if (options.json !== true) {
        console.log("Attention needed: at least one project is unavailable or needs attention.");
      }
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

function portfolioProjectNeedsAttention(project) {
  return project.status === "unavailable" || project.health === "needs_attention";
}

// One plain reason per project that is not simply ready; built only from the
// compact summary, so it never exposes record contents.
function portfolioAttentionReason(project) {
  if (project.status === "unavailable") {
    return project.message ?? "this project could not be read";
  }
  if (project.health !== "needs_attention" && project.health !== "review") return null;
  const parts = [];
  const count = (name) => project.aggregates?.[name]?.count ?? 0;
  if (count("blockers") > 0) parts.push(`${count("blockers")} blocker${count("blockers") === 1 ? "" : "s"}`);
  if ((project.aggregates?.budgets?.items ?? []).some((item) => item.health === "exceeded")) {
    parts.push("budget exceeded");
  }
  if (count("risks") > 0) parts.push(`${count("risks")} open risk${count("risks") === 1 ? "" : "s"}`);
  if ((project.counts?.diagnostics ?? 0) > 0) {
    parts.push(`${project.counts.diagnostics} diagnostic${project.counts.diagnostics === 1 ? "" : "s"} to review`);
  }
  return parts.length > 0 ? parts.join(", ") : "open this project in the observatory for details";
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
