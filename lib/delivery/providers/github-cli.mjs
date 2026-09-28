import { childProcess, crypto, Date } from "../../runtime/host.mjs";
import {
  isPlainRecord,
  normalizeIsoInstant,
  requireNonEmptyString,
} from "../../canonical.mjs";
import {
  DELIVERY_PROVIDER_SPI_VERSION,
  DeliveryProviderError,
} from "../provider-registry.mjs";

export const GITHUB_CLI_PROVIDER_ID = "github-cli";

const SHA_PATTERN = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u;
const ACTIONS = new Set([
  "pull_request.create",
  "pull_request.merge",
  "pull_request.update",
]);
const SUBJECT_KEYS = new Set([
  "authorized_at",
  "base_branch",
  "base_sha",
  "expected",
  "head_branch",
  "pr_url",
  "repository",
  "source_sha",
]);
const EXPECTED_UPDATE_KEYS = new Set(["base_branch", "body_sha256", "is_draft", "title"]);
const VIEW_BASE_FIELDS = "url,state,isDraft,headRefOid,headRefName,baseRefName,baseRefOid";

export function createGitHubCliProvider({ commandRunner = defaultCommandRunner } = {}) {
  if (typeof commandRunner !== "function") {
    throw new DeliveryProviderError("github-cli commandRunner must be a function", "provider_invalid");
  }
  return Object.freeze({
    id: GITHUB_CLI_PROVIDER_ID,
    adapter_version: "1.0.0",
    spi_version: DELIVERY_PROVIDER_SPI_VERSION,
    capabilities: Object.freeze({
      "pull_request.create": Object.freeze(["precondition", "completion"]),
      "pull_request.merge": Object.freeze(["precondition", "completion"]),
      "pull_request.update": Object.freeze(["precondition", "completion"]),
    }),
    observePrecondition(operation) {
      const subject = normalizeSubject(operation);
      if (operation.action === "pull_request.create") {
        return observeCreatePrecondition(commandRunner, subject);
      }
      const observed = viewPullRequest(commandRunner, subject.pr_url, fieldsFor(operation.action, "precondition"));
      assertExactOpenPullRequest(observed, subject, {
        requireReady: operation.action === "pull_request.merge",
      });
      if (operation.action === "pull_request.update") {
        const expected = subject.expected;
        if (updateMatches(observed, expected)) {
          throw new DeliveryProviderError(
            "pull_request.update already matches the exact requested state",
            "provider_transition_not_needed",
          );
        }
      }
      return pullRequestProof(observed, operation.action === "pull_request.update"
        ? { current: updateProjection(observed), expected: subject.expected }
        : {});
    },
    verifyCompletion(operation, { precondition_receipt: preconditionReceipt }) {
      const subject = normalizeSubject(operation);
      assertCompatiblePrecondition(operation.action, subject, preconditionReceipt);
      if (operation.action === "pull_request.create") {
        return verifyCreatedPullRequest(commandRunner, subject, preconditionReceipt);
      }
      const observed = viewPullRequest(commandRunner, subject.pr_url, fieldsFor(operation.action, "completion"));
      if (operation.action === "pull_request.merge") {
        return verifyMergedPullRequest(observed, subject, preconditionReceipt);
      }
      assertExactOpenPullRequest(observed, {
        ...subject,
        base_branch: subject.expected.base_branch || subject.base_branch,
      }, { requireReady: false });
      if (!updateMatches(observed, subject.expected)) {
        throw new DeliveryProviderError(
          "pull_request.update completion does not match the exact requested state",
          "provider_completion_unproven",
        );
      }
      assertTransitionTime(observed.updatedAt, subject.authorized_at, "pull_request.update");
      return pullRequestProof(observed, {
        expected: subject.expected,
        updated_at: observed.updatedAt,
        precondition_receipt_hash: preconditionReceipt.receipt_hash,
      });
    },
  });
}

export function canonicalGitHubPullRequestUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  const segments = parsed.pathname.replace(/^\/+|\/+$/gu, "").split("/");
  if (
    parsed.protocol !== "https:"
    || parsed.hostname.toLowerCase() !== "github.com"
    || parsed.username
    || parsed.password
    || parsed.port
    || parsed.search
    || parsed.hash
    || segments.length !== 4
    || segments[2] !== "pull"
    || !/^\d+$/u.test(segments[3])
  ) {
    return null;
  }
  return `https://github.com/${segments[0]}/${segments[1].replace(/\.git$/iu, "")}/pull/${segments[3]}`;
}

function normalizeSubject(operation) {
  if (!ACTIONS.has(operation?.action)) {
    throw new DeliveryProviderError(
      `GitHub CLI cannot prove '${operation?.action || "missing"}'`,
      "provider_operation_unsupported",
      { provider_id: GITHUB_CLI_PROVIDER_ID, action: operation?.action || null },
    );
  }
  const subject = operation.subject;
  if (!isPlainRecord(subject)) {
    throw new DeliveryProviderError(`${operation.action} subject must be an object`, "provider_operation_invalid");
  }
  const unknown = Object.keys(subject).filter((key) => !SUBJECT_KEYS.has(key));
  if (unknown.length > 0) {
    throw new DeliveryProviderError(
      `${operation.action} subject contains unsupported fields: ${unknown.sort().join(", ")}`,
      "provider_operation_invalid",
    );
  }
  const repository = normalizeGitHubRepository(subject.repository);
  const headBranch = normalizeBranch(subject.head_branch, `${operation.action}.subject.head_branch`);
  const baseBranch = normalizeBranch(subject.base_branch, `${operation.action}.subject.base_branch`);
  if (headBranch === baseBranch) {
    throw new DeliveryProviderError("Pull-request head and base branches must differ", "provider_operation_invalid");
  }
  const sourceSha = requireNonEmptyString(subject.source_sha, `${operation.action}.subject.source_sha`);
  if (!SHA_PATTERN.test(sourceSha)) {
    throw new DeliveryProviderError("Pull-request source_sha must be an exact lowercase Git object id", "provider_operation_invalid");
  }
  const baseSha = subject.base_sha === undefined
    ? null
    : requireNonEmptyString(subject.base_sha, `${operation.action}.subject.base_sha`);
  if (baseSha !== null && !SHA_PATTERN.test(baseSha)) {
    throw new DeliveryProviderError("Pull-request base_sha must be an exact lowercase Git object id", "provider_operation_invalid");
  }
  if (operation.action !== "pull_request.merge" && baseSha !== null) {
    throw new DeliveryProviderError(`${operation.action} does not accept a merge base SHA`, "provider_operation_invalid");
  }
  const authorizedAt = normalizeIsoInstant(subject.authorized_at, `${operation.action}.subject.authorized_at`);
  const prUrl = operation.action === "pull_request.create"
    ? normalizeOptionalPullRequestUrl(subject.pr_url, repository)
    : requireMatchingPullRequestUrl(subject.pr_url, repository);
  const expected = operation.action === "pull_request.update"
    ? normalizeExpectedUpdate(subject.expected)
    : null;
  if (operation.action !== "pull_request.update" && subject.expected !== undefined) {
    throw new DeliveryProviderError(`${operation.action} does not accept expected update state`, "provider_operation_invalid");
  }
  return {
    repository,
    head_branch: headBranch,
    base_branch: baseBranch,
    ...(baseSha === null ? {} : { base_sha: baseSha }),
    source_sha: sourceSha,
    authorized_at: authorizedAt,
    pr_url: prUrl,
    expected,
  };
}

function observeCreatePrecondition(commandRunner, subject) {
  const observed = listPullRequests(commandRunner, subject);
  const matching = exactPullRequests(observed, subject);
  assertExactListScope(observed, matching);
  if (matching.length > 0) {
    throw new DeliveryProviderError(
      "pull_request.create precondition is not satisfied because an exact open PR already exists",
      "provider_transition_not_needed",
      { matching_open_count: matching.length },
    );
  }
  return {
    repository: subject.repository,
    state: "ABSENT",
    head_sha: subject.source_sha,
    head_branch: subject.head_branch,
    base_branch: subject.base_branch,
    matching_open_count: 0,
  };
}

function verifyCreatedPullRequest(commandRunner, subject, preconditionReceipt) {
  const observed = listPullRequests(commandRunner, subject);
  const matching = exactPullRequests(observed, subject);
  assertExactListScope(observed, matching);
  if (matching.length !== 1) {
    throw new DeliveryProviderError(
      `pull_request.create completion requires exactly one exact open PR; found ${matching.length}`,
      "provider_completion_unproven",
    );
  }
  const created = matching[0];
  assertTransitionTime(created.createdAt, subject.authorized_at, "pull_request.create");
  if (subject.pr_url && canonicalGitHubPullRequestUrl(created.url) !== subject.pr_url) {
    throw new DeliveryProviderError("pull_request.create completion returned a different PR URL", "provider_completion_unproven");
  }
  return pullRequestProof(created, {
    created_at: created.createdAt,
    precondition_receipt_hash: preconditionReceipt.receipt_hash,
  });
}

function verifyMergedPullRequest(observed, subject, preconditionReceipt) {
  if (
    !isPlainRecord(observed)
    || observed.state !== "MERGED"
    || observed.isDraft === true
    || !observed.mergedAt
    || !isPlainRecord(observed.mergeCommit)
    || !SHA_PATTERN.test(observed.mergeCommit.oid || "")
    || observed.headRefOid !== subject.source_sha
    || observed.headRefName !== subject.head_branch
    || observed.baseRefName !== subject.base_branch
    || !SHA_PATTERN.test(observed.baseRefOid || "")
    || (subject.base_sha !== undefined && observed.baseRefOid !== subject.base_sha)
    || canonicalGitHubPullRequestUrl(observed.url) !== subject.pr_url
  ) {
    throw new DeliveryProviderError(
      "pull_request.merge completion is not proven by the exact PR, source SHA, branches, and merged state",
      "provider_completion_unproven",
    );
  }
  assertTransitionTime(observed.mergedAt, subject.authorized_at, "pull_request.merge");
  return pullRequestProof(observed, {
    merge_commit_sha: observed.mergeCommit.oid,
    merged_at: observed.mergedAt,
    precondition_receipt_hash: preconditionReceipt.receipt_hash,
  });
}

function assertExactOpenPullRequest(observed, subject, { requireReady }) {
  if (
    !isPlainRecord(observed)
    || observed.state !== "OPEN"
    || (requireReady && observed.isDraft !== false)
    || observed.headRefOid !== subject.source_sha
    || observed.headRefName !== subject.head_branch
    || observed.baseRefName !== subject.base_branch
    || (requireReady && !SHA_PATTERN.test(observed.baseRefOid || ""))
    || (subject.base_sha !== undefined && observed.baseRefOid !== subject.base_sha)
    || canonicalGitHubPullRequestUrl(observed.url) !== subject.pr_url
  ) {
    throw new DeliveryProviderError(
      "Pull-request precondition must be the exact open GitHub PR at the authorized source SHA and branches",
      "provider_precondition_unproven",
    );
  }
}

function assertCompatiblePrecondition(action, subject, receipt) {
  const proof = receipt?.proof;
  if (action === "pull_request.create") {
    if (
      proof?.state !== "ABSENT"
      || proof?.repository !== subject.repository
      || proof?.head_sha !== subject.source_sha
      || proof?.head_branch !== subject.head_branch
      || proof?.base_branch !== subject.base_branch
    ) {
      throw new DeliveryProviderError("pull_request.create precondition receipt is not exact", "provider_precondition_mismatch");
    }
    return;
  }
  if (
    proof?.state !== "OPEN"
    || proof?.pr_url !== subject.pr_url
    || proof?.head_sha !== subject.source_sha
    || proof?.head_branch !== subject.head_branch
    || proof?.base_branch !== subject.base_branch
    || (subject.base_sha !== undefined && proof?.base_sha !== subject.base_sha)
  ) {
    throw new DeliveryProviderError(`${action} precondition receipt is not exact`, "provider_precondition_mismatch");
  }
}

function fieldsFor(action, phase) {
  if (action === "pull_request.merge" && phase === "completion") {
    return `${VIEW_BASE_FIELDS},mergedAt,mergeCommit`;
  }
  if (action === "pull_request.update") {
    return `${VIEW_BASE_FIELDS},updatedAt,title,body`;
  }
  return VIEW_BASE_FIELDS;
}

function viewPullRequest(commandRunner, prUrl, fields) {
  const raw = runGitHub(commandRunner, ["pr", "view", prUrl, "--json", fields]);
  const parsed = parseJson(raw, "GitHub PR view");
  if (!isPlainRecord(parsed)) {
    throw new DeliveryProviderError("GitHub PR view returned a non-object response", "provider_invalid_output");
  }
  return parsed;
}

function listPullRequests(commandRunner, subject) {
  const fields = `${VIEW_BASE_FIELDS},createdAt`;
  const raw = runGitHub(commandRunner, [
    "pr", "list",
    "--repo", subject.repository,
    "--head", subject.head_branch,
    "--base", subject.base_branch,
    "--state", "open",
    "--limit", "2",
    "--json", fields,
  ]);
  const parsed = parseJson(raw, "GitHub PR list");
  if (!Array.isArray(parsed) || parsed.some((item) => !isPlainRecord(item))) {
    throw new DeliveryProviderError("GitHub PR list returned a non-array response", "provider_invalid_output");
  }
  return parsed;
}

function exactPullRequests(observed, subject) {
  return observed.filter((item) =>
    item.state === "OPEN"
    && item.headRefOid === subject.source_sha
    && item.headRefName === subject.head_branch
    && item.baseRefName === subject.base_branch
    && repositoryFromPullRequestUrl(item.url) === subject.repository);
}

function assertExactListScope(observed, matching) {
  if (observed.length !== matching.length) {
    throw new DeliveryProviderError(
      "GitHub PR list returned state outside the exact repository, SHA, or branch scope",
      "provider_invalid_output",
    );
  }
}

function pullRequestProof(observed, additions = {}) {
  return {
    pr_url: canonicalGitHubPullRequestUrl(observed.url),
    state: observed.state,
    is_draft: observed.isDraft === true,
    head_sha: observed.headRefOid,
    head_branch: observed.headRefName,
    base_branch: observed.baseRefName,
    ...(typeof observed.baseRefOid === "string" ? { base_sha: observed.baseRefOid } : {}),
    ...additions,
  };
}

function normalizeExpectedUpdate(expected) {
  if (!isPlainRecord(expected) || Object.keys(expected).length === 0) {
    throw new DeliveryProviderError("pull_request.update requires non-empty expected state", "provider_operation_invalid");
  }
  const unknown = Object.keys(expected).filter((key) => !EXPECTED_UPDATE_KEYS.has(key));
  if (unknown.length > 0) {
    throw new DeliveryProviderError(
      `pull_request.update expected state contains unsupported fields: ${unknown.sort().join(", ")}`,
      "provider_operation_invalid",
    );
  }
  const normalized = {};
  if (Object.hasOwn(expected, "title")) {
    normalized.title = requireNonEmptyString(expected.title, "pull_request.update.expected.title");
  }
  if (Object.hasOwn(expected, "body_sha256")) {
    const bodyHash = requireNonEmptyString(expected.body_sha256, "pull_request.update.expected.body_sha256");
    if (!/^[a-f0-9]{64}$/u.test(bodyHash)) {
      throw new DeliveryProviderError("expected.body_sha256 must be a lowercase SHA-256", "provider_operation_invalid");
    }
    normalized.body_sha256 = bodyHash;
  }
  if (Object.hasOwn(expected, "is_draft")) {
    if (typeof expected.is_draft !== "boolean") {
      throw new DeliveryProviderError("expected.is_draft must be boolean", "provider_operation_invalid");
    }
    normalized.is_draft = expected.is_draft;
  }
  if (Object.hasOwn(expected, "base_branch")) {
    normalized.base_branch = normalizeBranch(expected.base_branch, "pull_request.update.expected.base_branch");
  }
  return normalized;
}

function updateProjection(observed) {
  return {
    title: typeof observed.title === "string" ? observed.title : null,
    body_sha256: typeof observed.body === "string" ? sha256(observed.body) : null,
    is_draft: observed.isDraft === true,
    base_branch: observed.baseRefName,
  };
}

function updateMatches(observed, expected) {
  const current = updateProjection(observed);
  return Object.entries(expected).every(([key, value]) => current[key] === value);
}

function normalizeGitHubRepository(value) {
  const raw = requireNonEmptyString(value, "pull_request.subject.repository")
    .replace(/^https:\/\/github\.com\//iu, "")
    .replace(/^github\.com\//iu, "")
    .replace(/\.git$/iu, "");
  const segments = raw.split("/");
  if (
    segments.length !== 2
    || segments.some((segment) =>
      !/^[A-Za-z0-9_.-]+$/u.test(segment)
      || segment.startsWith("-")
      || segment === "."
      || segment === "..")
  ) {
    throw new DeliveryProviderError("Pull-request repository must be an exact GitHub owner/repository identity", "provider_operation_invalid");
  }
  return `${segments[0].toLowerCase()}/${segments[1].toLowerCase()}`;
}

function normalizeBranch(value, label) {
  const branch = requireNonEmptyString(value, label);
  if (
    branch.startsWith("-")
    || branch.includes("\0")
    || /[\s~^:?*[\\]/u.test(branch)
    || branch.includes("..")
    || branch.includes("@{")
    || branch.endsWith(".")
    || branch.endsWith("/")
    || branch.endsWith(".lock")
  ) {
    throw new DeliveryProviderError(`${label} must be an exact safe branch name`, "provider_operation_invalid");
  }
  return branch;
}

function normalizeOptionalPullRequestUrl(value, repository) {
  if (value === undefined || value === null) return null;
  return requireMatchingPullRequestUrl(value, repository);
}

function requireMatchingPullRequestUrl(value, repository) {
  const normalized = canonicalGitHubPullRequestUrl(requireNonEmptyString(value, "pull_request.subject.pr_url"));
  if (!normalized || repositoryFromPullRequestUrl(normalized) !== repository) {
    throw new DeliveryProviderError("Pull-request URL must exactly match the approved GitHub repository", "provider_operation_invalid");
  }
  return normalized;
}

function repositoryFromPullRequestUrl(value) {
  const normalized = canonicalGitHubPullRequestUrl(value);
  if (!normalized) return null;
  const parsed = new URL(normalized);
  const [owner, repository] = parsed.pathname.replace(/^\//u, "").split("/");
  return `${owner.toLowerCase()}/${repository.toLowerCase()}`;
}

function assertTransitionTime(value, authorizedAt, action) {
  let observed;
  let authorized;
  try {
    observed = Date.parse(normalizeIsoInstant(value, `${action}.provider_time`));
    authorized = Date.parse(normalizeIsoInstant(authorizedAt, `${action}.authorized_at`));
  } catch {
    throw new DeliveryProviderError(`${action} provider transition time is invalid`, "provider_completion_unproven");
  }
  if (observed < authorized) {
    throw new DeliveryProviderError(`${action} transition predates its authorization boundary`, "provider_completion_unproven");
  }
}

function runGitHub(commandRunner, args) {
  let output;
  try {
    output = commandRunner("gh", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
  } catch (error) {
    const stderr = Buffer.isBuffer(error?.stderr) ? error.stderr.toString("utf8") : error?.stderr;
    throw new DeliveryProviderError(
      `GitHub CLI observation failed: ${String(stderr || error?.message || error).trim().slice(0, 1_000)}`,
      "provider_observation_failed",
    );
  }
  if (typeof output !== "string" && !Buffer.isBuffer(output)) {
    throw new DeliveryProviderError("GitHub CLI runner must return stdout text", "provider_invalid_output");
  }
  return String(output);
}

function parseJson(raw, label) {
  try {
    return JSON.parse(raw);
  } catch {
    throw new DeliveryProviderError(`${label} returned invalid JSON`, "provider_invalid_output");
  }
}

function defaultCommandRunner(executable, args, options) {
  return childProcess.execFileSync(executable, args, {
    ...options,
    timeout: 30_000,
    maxBuffer: 10 * 1024 * 1024,
  });
}

function sha256(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}
