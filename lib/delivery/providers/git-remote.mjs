import path from "node:path";

import { childProcess } from "../../runtime/host.mjs";
import { isPlainRecord, requireNonEmptyString } from "../../canonical.mjs";
import {
  DELIVERY_PROVIDER_SPI_VERSION,
  DeliveryProviderError,
} from "../provider-registry.mjs";

export const GIT_REMOTE_PROVIDER_ID = "git-remote";

const SHA_PATTERN = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u;
const REMOTE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const SUBJECT_KEYS = new Set([
  "base_ref",
  "cwd",
  "destination_ref",
  "remote",
  "repository",
  "source_sha",
]);

export function createGitRemoteProvider({ commandRunner = defaultCommandRunner } = {}) {
  if (typeof commandRunner !== "function") {
    throw new DeliveryProviderError("git-remote commandRunner must be a function", "provider_invalid");
  }
  return Object.freeze({
    id: GIT_REMOTE_PROVIDER_ID,
    adapter_version: "1.0.0",
    spi_version: DELIVERY_PROVIDER_SPI_VERSION,
    capabilities: Object.freeze({
      "git.push": Object.freeze(["precondition", "completion"]),
    }),
    observePrecondition(operation, { runtime } = {}) {
      assertGitPushAction(operation);
      const subject = normalizeGitPushSubject(operation.subject, runtime);
      const refs = observeRemoteRefs(commandRunner, subject, [subject.destination_ref, subject.base_ref], "precondition");
      const destinationSha = singleRefSha(refs, subject.destination_ref, { allowMissing: true });
      const baseSha = singleRefSha(refs, subject.base_ref);
      if (destinationSha === subject.source_sha) {
        throw new DeliveryProviderError(
          `git.push destination ${subject.destination_ref} already equals ${subject.source_sha}`,
          "provider_transition_not_needed",
          { destination_ref: subject.destination_ref, source_sha: subject.source_sha },
        );
      }
      return {
        remote: subject.remote,
        base_ref: subject.base_ref,
        base_sha: baseSha,
        destination_ref: subject.destination_ref,
        previous_sha: destinationSha,
        source_sha: subject.source_sha,
      };
    },
    verifyCompletion(operation, { precondition_receipt: preconditionReceipt, runtime } = {}) {
      assertGitPushAction(operation);
      const subject = normalizeGitPushSubject(operation.subject, runtime);
      const proof = preconditionReceipt?.proof;
      if (
        proof?.remote !== subject.remote
        || proof?.base_ref !== subject.base_ref
        || proof?.destination_ref !== subject.destination_ref
        || proof?.source_sha !== subject.source_sha
        || proof?.previous_sha === subject.source_sha
        || !SHA_PATTERN.test(proof?.base_sha || "")
      ) {
        throw new DeliveryProviderError(
          "git.push completion lacks the exact distinct remote precondition",
          "provider_precondition_mismatch",
        );
      }
      const refs = observeRemoteRefs(commandRunner, subject, [subject.destination_ref], "completion");
      const observedSha = singleRefSha(refs, subject.destination_ref);
      if (observedSha !== subject.source_sha) {
        throw new DeliveryProviderError(
          `git.push completion is not proven: ${subject.destination_ref} does not resolve to the expected ${subject.source_sha}; observed ${observedSha}`,
          "provider_completion_unproven",
          { destination_ref: subject.destination_ref, observed_sha: observedSha, expected_sha: subject.source_sha },
        );
      }
      return {
        remote: subject.remote,
        destination_ref: subject.destination_ref,
        observed_sha: observedSha,
        source_sha: subject.source_sha,
        precondition_receipt_hash: preconditionReceipt.receipt_hash,
      };
    },
  });
}

function assertGitPushAction(operation) {
  if (operation?.action !== "git.push") {
    throw new DeliveryProviderError(
      `Generic Git cannot prove pull-request state for '${operation?.action || "missing"}'`,
      "provider_operation_unsupported",
      { provider_id: GIT_REMOTE_PROVIDER_ID, action: operation?.action || null },
    );
  }
}

function normalizeGitPushSubject(subject, runtime = {}) {
  if (!isPlainRecord(subject)) {
    throw new DeliveryProviderError("git.push subject must be an object", "provider_operation_invalid");
  }
  const unknown = Object.keys(subject).filter((key) => !SUBJECT_KEYS.has(key));
  if (unknown.length > 0) {
    throw new DeliveryProviderError(
      `git.push subject contains unsupported fields: ${unknown.sort().join(", ")}`,
      "provider_operation_invalid",
    );
  }
  const cwd = requireNonEmptyString(runtime?.cwd ?? subject.cwd, "git.push.runtime.cwd");
  if (!path.isAbsolute(cwd) || cwd.includes("\0")) {
    throw new DeliveryProviderError("git.push runtime.cwd must be an absolute path", "provider_operation_invalid");
  }
  const remote = requireNonEmptyString(subject.remote, "git.push.subject.remote");
  if (!REMOTE_PATTERN.test(remote)) {
    throw new DeliveryProviderError("git.push subject.remote must be an option-safe Git remote name", "provider_operation_invalid");
  }
  const destinationRef = normalizeHeadRef(subject.destination_ref, "git.push.subject.destination_ref");
  const baseRef = normalizeHeadRef(subject.base_ref, "git.push.subject.base_ref");
  if (destinationRef === baseRef) {
    throw new DeliveryProviderError("git.push base and destination refs must differ", "provider_operation_invalid");
  }
  const sourceSha = requireNonEmptyString(subject.source_sha, "git.push.subject.source_sha");
  if (!SHA_PATTERN.test(sourceSha)) {
    throw new DeliveryProviderError("git.push subject.source_sha must be an exact lowercase Git object id", "provider_operation_invalid");
  }
  const repository = subject.repository === undefined
    ? null
    : requireNonEmptyString(subject.repository, "git.push.subject.repository");
  return { cwd, remote, destination_ref: destinationRef, base_ref: baseRef, source_sha: sourceSha, repository };
}

function normalizeHeadRef(value, label) {
  const ref = requireNonEmptyString(value, label);
  if (
    !ref.startsWith("refs/heads/")
    || ref.length <= "refs/heads/".length
    || ref.includes("\0")
    || /[\s~^:?*[\\]/u.test(ref)
    || ref.includes("..")
    || ref.includes("@{")
    || ref.endsWith(".")
    || ref.endsWith("/")
    || ref.endsWith(".lock")
  ) {
    throw new DeliveryProviderError(`${label} must be an exact safe branch ref`, "provider_operation_invalid");
  }
  return ref;
}

function observeRemoteRefs(commandRunner, subject, refs, phase) {
  let output;
  try {
    output = commandRunner(
      "git",
      ["-C", subject.cwd, "ls-remote", "--heads", subject.remote, ...refs],
      {
        cwd: subject.cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
      },
    );
  } catch (error) {
    throw new DeliveryProviderError(
      `git.push ${phase} observation failed: ${commandError(error)}`,
      "provider_observation_failed",
      { phase, remote: subject.remote, refs },
    );
  }
  if (typeof output !== "string" && !Buffer.isBuffer(output)) {
    throw new DeliveryProviderError("git-remote runner must return stdout text", "provider_invalid_output");
  }
  return parseRemoteRefs(String(output), new Set(refs));
}

function parseRemoteRefs(output, expectedRefs) {
  const refs = new Map([...expectedRefs].map((ref) => [ref, []]));
  for (const line of output.split(/\r?\n/u).map((item) => item.trim()).filter(Boolean)) {
    const parts = line.split(/\s+/u);
    if (parts.length !== 2 || !SHA_PATTERN.test(parts[0]) || !expectedRefs.has(parts[1])) {
      throw new DeliveryProviderError("git ls-remote returned malformed or unexpected output", "provider_invalid_output");
    }
    refs.get(parts[1]).push(parts[0]);
  }
  return refs;
}

function singleRefSha(refs, ref, { allowMissing = false } = {}) {
  const matches = refs.get(ref) || [];
  if (matches.length === 0 && allowMissing) return null;
  if (matches.length !== 1) {
    throw new DeliveryProviderError(
      `git remote observation requires exactly one value for ${ref}; found ${matches.length}`,
      "provider_ambiguous_observation",
      { ref, count: matches.length },
    );
  }
  return matches[0];
}

function defaultCommandRunner(executable, args, options) {
  return childProcess.execFileSync(executable, args, {
    ...options,
    timeout: 30_000,
    maxBuffer: 10 * 1024 * 1024,
  });
}

function commandError(error) {
  const stderr = Buffer.isBuffer(error?.stderr) ? error.stderr.toString("utf8") : error?.stderr;
  return String(stderr || error?.message || error || "unknown Git error").trim().slice(0, 1_000);
}
