import path from "node:path";
import {
  fail,
} from "../cli/user-error.mjs";
import {
  compactText,
  mergeList,
  normalizeId,
  normalizeListOption,
  normalizeListValue,
  pushAllUnique,
} from "./common.mjs";
import {
  CAPABILITY_GROUPS,
  CAPABILITY_RECOMMENDATION_AVAILABILITY,
  CAPABILITY_TYPES,
} from "./constants.mjs";
import {
  formatLimitedList,
} from "./output.mjs";
import {
  normalizeRoutePhase,
} from "./route.mjs";

export function capabilityRecordMatchesStory(context, record, storyId = null) {
  if (!storyId) {
    return true;
  }
  const subjectStoryId = record.subject?.story_id || null;
  return !subjectStoryId || subjectStoryId === storyId;
}

export function formatCapabilitySubject(subject = {}) {
  const parts = [
    subject.scope ? `scope ${subject.scope}` : null,
    subject.phase ? `phase ${subject.phase}` : null,
    subject.story_id ? `work item ${subject.story_id}` : null,
    subject.requirement_ids?.length ? `requirements ${subject.requirement_ids.join(", ")}` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : "project-level work";
}

export function formatCapabilityEvidenceForUser(evidence = []) {
  const entries = evidence
    .slice(0, 10)
    .map((item) => {
      const label = [item.type || "evidence", item.path ? `from ${item.path}` : null].filter(Boolean).join(" ");
      return item.summary ? `${label}: ${compactText(item.summary, 140)}` : label;
    })
    .filter(Boolean);
  return entries.length ? formatLimitedList(entries, 10) : "no evidence listed";
}

export function formatCapabilityRecommendationsForUser(recommendations = []) {
  const entries = recommendations
    .slice(0, 10)
    .map((item) => {
      const permissionText = item.permissions?.length ? ` permissions ${item.permissions.join("/")}` : "";
      const installText = item.install_required ? " requires install approval" : " no install";
      const purposeText = item.purpose ? ` - ${compactText(item.purpose, 120)}` : "";
      return `${item.type}:${item.name} (${item.availability || "unknown"};${permissionText}${installText})${purposeText}`;
    })
    .filter(Boolean);
  return entries.length ? formatLimitedList(entries, 10) : "no concrete capabilities listed";
}

export function formatCapabilityPolicyPatchForUser(policy = null) {
  const normalized = buildCapabilityPolicy(policy);
  const group = (name) => normalized[name] || emptyCapabilitySet();
  const required = [
    ...group("skills").required.map((name) => `skill:${name}`),
    ...group("mcp").required.map((name) => `mcp:${name}`),
    ...group("tools").required.map((name) => `tool:${name}`),
    ...group("plugins").required.map((name) => `plugin:${name}`),
    ...group("connectors").required.map((name) => `connector:${name}`),
    ...group("models").required.map((name) => `model:${name}`),
  ];
  const allowed = [
    ...group("skills").allowed.map((name) => `skill:${name}`),
    ...group("mcp").allowed.map((name) => `mcp:${name}`),
    ...group("tools").allowed.map((name) => `tool:${name}`),
    ...group("plugins").allowed.map((name) => `plugin:${name}`),
    ...group("connectors").allowed.map((name) => `connector:${name}`),
    ...group("models").allowed.map((name) => `model:${name}`),
  ];
  const forbidden = [
    ...group("skills").forbidden.map((name) => `skill:${name}`),
    ...group("mcp").forbidden.map((name) => `mcp:${name}`),
    ...group("tools").forbidden.map((name) => `tool:${name}`),
    ...group("plugins").forbidden.map((name) => `plugin:${name}`),
    ...group("connectors").forbidden.map((name) => `connector:${name}`),
    ...group("models").forbidden.map((name) => `model:${name}`),
  ];
  return [
    required.length ? `Required tools/capabilities: ${formatLimitedList(required, 8)}` : null,
    allowed.length ? `Allowed tools/capabilities: ${formatLimitedList(allowed, 8)}` : null,
    forbidden.length ? `Forbidden tools/capabilities: ${formatLimitedList(forbidden, 8)}` : null,
    normalized.approval_required_for.length ? `Extra approval required for: ${formatLimitedList(normalized.approval_required_for, 8)}` : null,
  ].filter(Boolean).join(" | ") || null;
}

export function formatCapabilityBindingsForUser(bindings = []) {
  const entries = bindings
    .slice(0, 8)
    .map((binding) => {
      const permissions = binding.permissions?.length ? ` permissions ${binding.permissions.join("/")}` : "";
      const target = binding.target && Object.keys(binding.target).length ? ` target ${compactText(JSON.stringify(binding.target), 120)}` : "";
      return `${binding.type}:${binding.name}${binding.binding_id ? ` (${binding.binding_id})` : ""}${permissions}${target}`;
    })
    .filter(Boolean);
  return entries.length ? formatLimitedList(entries, 8) : "no specific bindings";
}

export function formatCapabilityInstallNeeds(recommendations = []) {
  const installs = (recommendations || [])
    .filter((item) => item.install_required && !item.install_approved)
    .map((item) => `${item.type}:${item.name}`)
    .filter(Boolean);
  return installs.length ? formatLimitedList(installs, 8) : "no pending installs";
}

export function collectCapabilityPolicyReadinessGaps(contract) {
  const label = `contract ${contract.id || contract.phase || "work brief"}`;
  const policy = contract.capability_policy ?? buildCapabilityPolicy(null);
  const report = { errors: [] };
  validateCapabilityPolicy(policy, `${label} capability_policy`, report);
  return report.errors.map((error) => ({
    code: "invalid_capability_policy",
    summary: error,
    question:
      "Replace capability_policy with valid skills, mcp, and tools groups "
      + "whose required, allowed, and forbidden lists do not conflict.",
  }));
}

export function collectMissingRequiredCapabilityBindings(contract, options = {}) {
  const policy = contract.capability_policy || buildCapabilityPolicy(null);
  const rawBindings = Array.isArray(contract.capability_bindings) ? contract.capability_bindings : [];
  const bindings = Array.isArray(options.bindings)
    ? options.bindings
    : rawBindings.map((binding, index) => normalizeCapabilityBinding(binding, index));
  const missing = [];
  for (const type of ["mcp", "tools"]) {
    const required = Array.isArray(policy?.[type]?.required)
      ? policy[type].required
          .filter((name) => typeof name === "string")
          .map((name) => name.trim())
          .filter(Boolean)
      : [];
    for (const name of required) {
      if (
        !capabilityHasBinding(bindings, type, name)
        && !contractHasCapabilityOpenQuestion(contract, type, name)
      ) {
        missing.push({ type, name });
      }
    }
  }
  return missing;
}

export function buildCapabilityPolicy(policy) {
  const empty = {
    skills: emptyCapabilitySet(),
    mcp: emptyCapabilitySet(),
    tools: emptyCapabilitySet(),
    approval_required_for: [],
  };
  if (policy === null || policy === undefined) {
    return empty;
  }
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
    fail("capability_policy must be a JSON object");
  }
  const normalized = {
    skills: normalizeCapabilitySet(policy.skills),
    mcp: normalizeCapabilitySet(policy.mcp),
    tools: normalizeCapabilitySet(policy.tools),
    approval_required_for: normalizeListValue(policy.approval_required_for, []),
  };
  validateCapabilityPolicy(normalized, "capability_policy");
  return normalized;
}

export function emptyCapabilitySet() {
  return {
    required: [],
    allowed: [],
    forbidden: [],
  };
}

export function normalizeCapabilitySet(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    required: normalizeListValue(source.required, []),
    allowed: normalizeListValue(source.allowed, []),
    forbidden: normalizeListValue(source.forbidden, []),
  };
}

export function validateCapabilityPolicy(policy, label, report = null) {
  const errors = [];
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
    errors.push(`${label} must be an object`);
  } else {
    for (const type of CAPABILITY_TYPES) {
      const group = policy[type];
      if (!group || typeof group !== "object" || Array.isArray(group)) {
        errors.push(`${label}.${type} must be an object`);
        continue;
      }
      for (const key of CAPABILITY_GROUPS) {
        if (!Array.isArray(group[key])) {
          errors.push(`${label}.${type}.${key} must be an array`);
          continue;
        }
        for (const [index, value] of group[key].entries()) {
          if (typeof value !== "string" || !value.trim()) {
            errors.push(`${label}.${type}.${key}[${index}] must be a non-empty string`);
          }
        }
      }
      const required = new Set(
        Array.isArray(group.required)
          ? group.required
              .filter((value) => typeof value === "string" && value.trim())
              .map((value) => value.trim())
          : [],
      );
      const allowed = new Set(
        Array.isArray(group.allowed)
          ? group.allowed
              .filter((value) => typeof value === "string" && value.trim())
              .map((value) => value.trim())
          : [],
      );
      const forbidden = new Set(
        Array.isArray(group.forbidden)
          ? group.forbidden
              .filter((value) => typeof value === "string" && value.trim())
              .map((value) => value.trim())
          : [],
      );
      for (const value of required) {
        if (forbidden.has(value)) {
          errors.push(`${label}.${type} capability '${value}' cannot be both required and forbidden`);
        }
      }
      for (const value of allowed) {
        if (forbidden.has(value)) {
          errors.push(`${label}.${type} capability '${value}' cannot be both allowed and forbidden`);
        }
      }
    }
    if (!Array.isArray(policy.approval_required_for)) {
      errors.push(`${label}.approval_required_for must be an array`);
    }
  }
  if (report) {
    report.errors.push(...errors);
    return errors.length === 0;
  }
  if (errors.length > 0) {
    fail(errors.join("; "));
  }
  return true;
}

export function normalizeCapabilityBindings(bindings) {
  if (!Array.isArray(bindings)) {
    fail("capability_bindings must be an array");
  }
  return bindings.map((binding, index) => normalizeCapabilityBinding(binding, index));
}

export function normalizeCapabilityRecommendationRefs(refs) {
  if (!Array.isArray(refs)) {
    fail("capability_recommendation_refs must be an array");
  }
  return refs.map((ref, index) => {
    if (!ref || typeof ref !== "object" || Array.isArray(ref)) {
      fail(`capability recommendation ref ${index + 1} must be a JSON object`);
    }
    return {
      id: normalizeId(ref.id),
      profile_id: ref.profile_id ? normalizeId(ref.profile_id) : null,
      path: String(ref.path || "").trim(),
      approved_content_hash: String(ref.approved_content_hash || "").trim(),
    };
  });
}

export function normalizeCapabilityBinding(binding, index = 0) {
  if (!binding || typeof binding !== "object" || Array.isArray(binding)) {
    fail(`capability binding ${index + 1} must be a JSON object`);
  }
  const type = String(binding.type || "").trim().toLowerCase();
  if (!["skill", "mcp", "tool"].includes(type)) {
    fail(`capability binding ${index + 1} type must be skill, mcp, or tool`);
  }
  const name = String(binding.name || "").trim();
  if (!name) {
    fail(`capability binding ${index + 1} is missing name`);
  }
  const target = binding.target && typeof binding.target === "object" && !Array.isArray(binding.target) ? binding.target : null;
  if (!target || Object.keys(target).length === 0) {
    fail(`capability binding ${index + 1} is missing a concrete target object`);
  }
  return {
    type,
    name,
    binding_id: normalizeId(binding.binding_id || `${type}-${name}`),
    target,
    permissions: normalizeListValue(binding.permissions, []),
    requires_approval_for: normalizeListValue(binding.requires_approval_for, []),
    environment: binding.environment ? String(binding.environment) : null,
    notes: normalizeListValue(binding.notes, []),
  };
}

export function capabilityHasBinding(bindings, type, name) {
  const bindingType = type === "tools" ? "tool" : type === "skills" ? "skill" : type;
  return bindings.some((binding) => binding.type === bindingType && binding.name === name);
}

export function contractHasCapabilityOpenQuestion(contract, type, name) {
  const questions = contract.contextualization?.questions || [];
  return questions.some((question) => {
    const text = `${question.question || ""} ${question.id || ""} ${question.label || ""}`.toLowerCase();
    return question.status !== "answered" && text.includes(type.toLowerCase()) && text.includes(String(name).toLowerCase());
  });
}

export function capabilityTargetValueIsConcrete(value, seen = new WeakSet()) {
  if (typeof value === "string") {
    const text = value.trim();
    if (!text) {
      return false;
    }
    return !(
      /<[^<>]+>/u.test(text)
      || /\$\{[^{}]+\}/u.test(text)
      || /\{\{[^{}]+\}\}/u.test(text)
    );
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (!value || typeof value !== "object") {
    return false;
  }
  if (seen.has(value)) {
    return false;
  }
  seen.add(value);
  const values = Array.isArray(value) ? value : Object.values(value);
  return values.some((item) => capabilityTargetValueIsConcrete(item, seen));
}

export function capabilityTargetKeyIsPathLike(key) {
  const tokens = String(key || "")
    .replace(/([a-z0-9])([A-Z])/gu, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter(Boolean);
  const pathTokens = new Set([
    "path",
    "root",
    "workspace",
    "directory",
    "dir",
    "folder",
    "file",
    "cwd",
    "repository",
    "repo",
    "location",
  ]);
  return tokens.some((token) => {
    if (pathTokens.has(token)) {
      return true;
    }
    if (token.endsWith("s") && pathTokens.has(token.slice(0, -1))) {
      return true;
    }
    if (token.endsWith("ies") && pathTokens.has(`${token.slice(0, -3)}y`)) {
      return true;
    }
    return false;
  });
}

export function capabilityTargetValueLooksLikePath(value) {
  const text = String(value || "").trim();
  if (!text) {
    return false;
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(text)) {
    return text.toLowerCase().startsWith("file://");
  }
  return (
    path.isAbsolute(text)
    || path.win32.isAbsolute(text)
    || text.startsWith("./")
    || text.startsWith("../")
    || text.includes("/")
    || text.includes("\\")
  );
}

export function visitCapabilityTargetValues(
  value,
  visitor,
  settings = {},
  seen = new WeakSet(),
) {
  const trail = settings.trail || [];
  const pathLike = settings.pathLike === true;
  if (!value || typeof value !== "object") {
    visitor(value, { trail, pathLike });
    return;
  }
  if (seen.has(value)) {
    return;
  }
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      visitCapabilityTargetValues(
        item,
        visitor,
        { trail: [...trail, String(index)], pathLike },
        seen,
      );
    });
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    visitCapabilityTargetValues(
      item,
      visitor,
      {
        trail: [...trail, key],
        pathLike: pathLike || capabilityTargetKeyIsPathLike(key),
      },
      seen,
    );
  }
}

export function capabilityTargetFilesystemPath(value, pathLike) {
  if (typeof value !== "string") {
    return null;
  }
  const text = value.trim();
  if (!text) {
    return null;
  }
  const uri = text.match(/^([a-z][a-z0-9+.-]*):\/\//iu);
  if (uri && uri[1].toLowerCase() !== "file") {
    return null;
  }
  if (!pathLike && !capabilityTargetValueLooksLikePath(text)) {
    return null;
  }
  if (uri?.[1].toLowerCase() === "file") {
    return decodeURIComponent(new URL(text).pathname);
  }
  return text;
}

export function mergeCapabilityPolicies(...policies) {
  const merged = buildCapabilityPolicy(null);
  for (const policy of policies.filter(Boolean)) {
    const normalized = buildCapabilityPolicy(policy);
    for (const type of CAPABILITY_TYPES) {
      for (const group of CAPABILITY_GROUPS) {
        pushAllUnique(merged[type][group], normalized[type][group]);
      }
    }
    pushAllUnique(merged.approval_required_for, normalized.approval_required_for);
  }
  validateCapabilityPolicy(merged, "capability_policy");
  return merged;
}

export function normalizeCapabilityOpenQuestions(questions, recommendationId) {
  if (!Array.isArray(questions)) {
    return [];
  }
  return questions
    .map((question) => {
      if (typeof question === "string") {
        return question;
      }
      if (question && typeof question === "object") {
        return question.question || question.prompt || question.label || question.id;
      }
      return null;
    })
    .filter(Boolean)
    .map((question) => `Capability recommendation ${recommendationId}: ${question}`);
}

export function capabilityDiscoveryRoot(context) {
  return path.join(context.sdlcRoot, "capability-discovery");
}

export function capabilityProfilesRoot(context) {
  return path.join(capabilityDiscoveryRoot(context), "profiles");
}

export function capabilityRecommendationsRoot(context) {
  return path.join(capabilityDiscoveryRoot(context), "recommendations");
}

export function capabilityProfilePath(context, id) {
  return path.join(capabilityProfilesRoot(context), `${normalizeId(id)}.json`);
}

export function capabilityRecommendationPath(context, id) {
  return path.join(capabilityRecommendationsRoot(context), `${normalizeId(id)}.json`);
}

export function normalizeCapabilitySubject(options, subject) {
  const requirementIds = mergeList(
    normalizeListValue(subject.requirement_ids || subject.requirements, []),
    normalizeListOption(options.requirement),
  ).map(normalizeId);
  return {
    story_id: options.story ? normalizeId(String(options.story)) : subject.story_id ? normalizeId(subject.story_id) : null,
    requirement_ids: requirementIds,
    phase: options.phase ? normalizeRoutePhase(options.phase) : subject.phase ? normalizeRoutePhase(subject.phase) : null,
    scope: String(options.scope || subject.scope || "project"),
  };
}

export function normalizeCapabilityEvidence(evidence) {
  if (!Array.isArray(evidence)) {
    return [];
  }
  return evidence
    .filter((item) => item && typeof item === "object" && !Array.isArray(item))
    .map((item) => ({
      type: String(item.type || "evidence"),
      path: item.path ? String(item.path) : null,
      summary: item.summary ? String(item.summary) : null,
      sha256: item.sha256 ? String(item.sha256) : null,
    }));
}

export function normalizeCapabilityRecommendations(recommendations) {
  if (!Array.isArray(recommendations)) {
    fail("Capability recommendations must be an array");
  }
  return recommendations.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      fail(`Capability recommendation ${index + 1} must be a JSON object`);
    }
    const type = normalizeCapabilityItemType(item.type);
    const name = String(item.name || "").trim();
    if (!name) {
      fail(`Capability recommendation ${index + 1} is missing name`);
    }
    const availability = normalizeCapabilityAvailability(item.availability || item.status || "unknown");
    const installRequired = Boolean(item.install_required || availability === "install_required");
    return {
      type,
      name,
      availability: installRequired ? "install_required" : availability,
      purpose: item.purpose ? String(item.purpose) : null,
      rationale: item.rationale ? String(item.rationale) : null,
      risk: item.risk ? String(item.risk) : null,
      permissions: normalizeListValue(item.permissions, []),
      install_required: installRequired,
      install_approved: Boolean(item.install_approved),
      approval_required: item.approval_required !== undefined ? Boolean(item.approval_required) : installRequired,
    };
  });
}

export function normalizeCapabilityItemType(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!["skill", "mcp", "tool", "plugin", "connector", "model"].includes(normalized)) {
    fail(`Unknown capability recommendation type '${value}'`);
  }
  return normalized;
}

export function normalizeCapabilityAvailability(value) {
  const normalized = String(value || "unknown").trim().toLowerCase();
  if (!CAPABILITY_RECOMMENDATION_AVAILABILITY.has(normalized)) {
    fail(`Unknown capability availability '${value}'`);
  }
  return normalized;
}

export function buildDefaultCapabilityRecommendations(profile, availableCapabilities) {
  const availableSkills = new Set(normalizeAvailableCapabilityNames(availableCapabilities, "skills"));
  const recommendations = [
    {
      type: "skill",
      name: "agentic-sdlc",
      // This default is produced by the running Agentic SDLC plugin itself.
      // The optional inventory is needed only to attest additional host
      // capabilities; absence of that inventory must not make the plugin's own
      // intrinsic governance capability unusable after approval.
      availability: "available",
      purpose: "Govern the work through contracts, gates, traces, and shared project KB.",
      rationale: availableSkills.has("agentic-sdlc")
        ? "The reviewed inventory and the running plugin both confirm this capability."
        : "The running plugin provides this intrinsic governance capability.",
      install_required: false,
    },
  ];
  const hasNode = (profile.detected_stack || []).some((item) => ["node", "npm", "package-json"].includes(item.name) || item.type === "node");
  if (hasNode) {
    recommendations.push({
      type: "tool",
      name: "test-runner",
      availability: "available",
      purpose: "Run the repository's Node checks and tests.",
      rationale: "package.json is present and exposes the project test surface.",
      permissions: ["read", "execute"],
      install_required: false,
    });
  }
  const declaredGroups = [
    ["skills", "skill"],
    ["tools", "tool"],
    ["mcp", "mcp"],
    ["plugins", "plugin"],
    ["connectors", "connector"],
    ["models", "model"],
  ];
  const recommendedKeys = new Set(recommendations.map((item) => `${item.type}\0${item.name}`));
  for (const [group, type] of declaredGroups) {
    for (const item of normalizeAvailableCapabilityEntries(availableCapabilities, group)) {
      const key = `${type}\0${item.name}`;
      if (recommendedKeys.has(key) || item.recommended === false) continue;
      recommendations.push({
        type,
        name: item.name,
        availability: "available",
        purpose: item.purpose || item.description || `Use the declared available ${type} capability for this work.`,
        rationale: item.rationale || "The capability was supplied in the reviewed available-capabilities inventory.",
        permissions: normalizeListValue(item.permissions, type === "tool" ? ["read", "execute"] : []),
        install_required: false,
      });
      recommendedKeys.add(key);
    }
  }
  return recommendations;
}

export function normalizeAvailableCapabilityEntries(availableCapabilities, key) {
  const value = availableCapabilities?.[key] || availableCapabilities?.[key.replace(/s$/, "")] || [];
  const rawEntries = Array.isArray(value)
    ? value
    : value && typeof value === "object"
      ? value.installed || value.available || value.names || []
      : [];
  return (Array.isArray(rawEntries) ? rawEntries : [])
    .map((item) => typeof item === "string" ? { name: item } : item)
    .filter((item) => item && typeof item === "object" && !Array.isArray(item))
    .map((item) => ({ ...item, name: String(item.name || "").trim() }))
    .filter((item) => item.name);
}

export function normalizeAvailableCapabilityNames(availableCapabilities, key) {
  return normalizeAvailableCapabilityEntries(availableCapabilities, key).map((item) => item.name);
}

export function buildDefaultCapabilityPolicyPatch(recommendations) {
  const policy = buildCapabilityPolicy(null);
  for (const item of recommendations) {
    const group = item.install_required ? "required" : "allowed";
    if (item.type === "skill") {
      pushAllUnique(policy.skills[group], [item.name]);
    } else if (item.type === "mcp") {
      pushAllUnique(policy.mcp[group], [item.name]);
    } else if (item.type === "tool") {
      pushAllUnique(policy.tools[group], [item.name]);
    }
    if (item.approval_required) {
      pushAllUnique(policy.approval_required_for, [`${item.type}:${item.name}`]);
    }
  }
  return policy;
}
