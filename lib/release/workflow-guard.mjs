import { createHash } from "node:crypto";
import {
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import path from "node:path";


const SEMVER = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-((?:0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u;
const ARCHIVE_NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]*\.tgz$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const SOURCE_SHA = /^[0-9a-f]{40}$/u;
const RUN_ID = /^[1-9][0-9]*$/u;
const OWNER_SCHEMA = "agentic-sdlc.github-actions-release-owner.v1";
const BUNDLE_SCHEMA = "agentic-sdlc.release-bundle.v1";
const WORKFLOW_PATH = ".github/workflows/release.yml";
const LIMITS = Object.freeze({
  archive: 16 * 1024 * 1024,
  checksum: 1024,
  cyclonedx: 32 * 1024 * 1024,
  manifest: 64 * 1024,
  sbom: 32 * 1024 * 1024,
  verification: 1024 * 1024,
});


export class ReleaseWorkflowGuardError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ReleaseWorkflowGuardError";
    this.code = code;
  }
}


function fail(code, message) {
  throw new ReleaseWorkflowGuardError(code, message);
}


function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}


function assertPlainObject(value, label) {
  if (!isPlainObject(value)) fail("INVALID_RELEASE_RECORD", `${label} must be an object`);
}


function assertExactKeys(value, expected, label) {
  assertPlainObject(value, label);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    fail("INVALID_RELEASE_RECORD", `${label} fields do not match the sealed contract`);
  }
}


function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}


function parseJson(buffer, label) {
  try {
    return JSON.parse(buffer.toString("utf8"));
  } catch (error) {
    fail("INVALID_RELEASE_JSON", `${label} is not valid JSON: ${error.message}`);
  }
}


function requireIdentity({ archiveName, repository, runId, sourceSha, tag }) {
  if (typeof repository !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) {
    fail("INVALID_RELEASE_IDENTITY", "expected repository is invalid");
  }
  if (typeof sourceSha !== "string" || !SOURCE_SHA.test(sourceSha)) {
    fail("INVALID_RELEASE_IDENTITY", "expected source SHA is invalid");
  }
  if (typeof runId !== "string" || !RUN_ID.test(runId)) {
    fail("INVALID_RELEASE_IDENTITY", "expected workflow run id is invalid");
  }
  if (typeof archiveName !== "string" || archiveName.length > 240 || !ARCHIVE_NAME.test(archiveName)) {
    fail("INVALID_RELEASE_IDENTITY", "expected archive name is invalid");
  }
  return parseReleaseTag(tag);
}


function releaseState(metadata) {
  if (metadata.isDraft === true) return "draft";
  if (metadata.isDraft === false) return "published";
  fail("INVALID_RELEASE_METADATA", "release draft state is invalid");
}


function validateBundleRecord(record, expectedName, label) {
  assertExactKeys(record, ["bytes", "name", "sha256"], label);
  if (record.name !== expectedName
    || !Number.isSafeInteger(record.bytes)
    || record.bytes < 2
    || !SHA256.test(record.sha256 ?? "")) {
    fail("INVALID_RELEASE_MANIFEST", `${label} is not a valid sealed asset record`);
  }
}


function safeBundleFile(root, name, maximumBytes) {
  const file = path.join(root, name);
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 2 || stat.size > maximumBytes) {
    fail("INVALID_RELEASE_ASSET", `release asset is not a bounded regular file: ${name}`);
  }
  const realFile = realpathSync(file);
  if (path.dirname(realFile) !== root || path.basename(realFile) !== name) {
    fail("INVALID_RELEASE_ASSET", `release asset escapes its bundle directory: ${name}`);
  }
  const content = readFileSync(realFile);
  if (content.length !== stat.size) fail("RELEASE_ASSET_CHANGED", `release asset changed while being read: ${name}`);
  return content;
}


function validateManifestOwner(manifest, { repository, runId, sourceSha, tag }) {
  assertExactKeys(manifest, [
    "archive",
    "cyclonedx",
    "policy",
    "producer",
    "repository",
    "sbom",
    "schema_version",
    "source_sha",
    "tag",
    "verification",
  ], "release manifest");
  assertExactKeys(manifest.producer, ["run_id", "schema_version", "workflow_path"], "release owner");
  if (manifest.schema_version !== BUNDLE_SCHEMA
    || manifest.repository !== repository
    || manifest.tag !== tag
    || manifest.source_sha !== sourceSha
    || manifest.producer.schema_version !== OWNER_SCHEMA
    || manifest.producer.workflow_path !== WORKFLOW_PATH
    || manifest.producer.run_id !== runId) {
    fail("RELEASE_OWNERSHIP_MISMATCH", "release manifest is not owned by this exact workflow run");
  }
}


function validateSemanticAssets(files, manifest, identity) {
  const sbom = parseJson(files.get(manifest.sbom.name), "SPDX SBOM");
  if (sbom?.spdxVersion !== "SPDX-2.3"
    || sbom?.dataLicense !== "CC0-1.0"
    || !Array.isArray(sbom?.packages)
    || !sbom.packages.some((entry) => entry?.name === "agentic-sdlc")) {
    fail("INVALID_RELEASE_SBOM", "SPDX SBOM does not describe the release package");
  }
  const cyclonedx = parseJson(files.get(manifest.cyclonedx.name), "CycloneDX SBOM");
  if (cyclonedx?.bomFormat !== "CycloneDX"
    || !/^1\.[4-9]$/u.test(cyclonedx?.specVersion ?? "")
    || !Array.isArray(cyclonedx?.components)
    || !cyclonedx.components.some((entry) => entry?.name === "agentic-sdlc")) {
    fail("INVALID_RELEASE_SBOM", "CycloneDX SBOM does not describe the release package");
  }
  const verification = parseJson(files.get(manifest.verification.name), "release verification");
  if (verification?.status !== "passed"
    || verification?.package?.name !== "agentic-sdlc"
    || verification?.package?.version !== identity.version
    || verification?.package?.tag !== identity.tag
    || verification?.artifact?.sha256 !== manifest.archive.sha256
    || verification?.smoke?.npm_install !== "passed"
    || verification?.smoke?.cli_help !== "passed"
    || verification?.smoke?.doctor !== "passed"
    || verification?.smoke?.installer_plan !== "passed"
    || verification?.smoke?.installer_zero_write !== true
    || verification?.smoke?.installer_v2_plan !== "passed"
    || verification?.smoke?.installer_v2_zero_write !== true) {
    fail("INVALID_RELEASE_VERIFICATION", "release verification does not prove every required smoke gate");
  }
}


export function parseReleaseTag(tag) {
  if (typeof tag !== "string" || !tag.startsWith("v")) {
    fail("INVALID_RELEASE_TAG", "release tag must be v followed by a strict SemVer version");
  }
  const version = tag.slice(1);
  const match = SEMVER.exec(version);
  if (!match) {
    fail("INVALID_RELEASE_TAG", "release tag must be v followed by a strict SemVer version");
  }
  return Object.freeze({
    tag,
    version,
    prerelease: match[4] ?? null,
    build: match[5] ?? null,
    isPrerelease: match[4] !== undefined,
  });
}


export function expectedReleaseAssetNames(archiveName) {
  if (typeof archiveName !== "string" || archiveName.length > 240 || !ARCHIVE_NAME.test(archiveName)) {
    fail("INVALID_RELEASE_IDENTITY", "expected archive name is invalid");
  }
  return Object.freeze([
    archiveName,
    `${archiveName}.sha256`,
    `${archiveName}.cdx.json`,
    `${archiveName}.spdx.json`,
    "release-manifest.json",
    "release-verification.json",
  ].sort());
}


export function validateReleaseMetadata(metadata, {
  archiveName,
  expectedSizes,
  expectedState = "either",
  repository,
  runId,
  sourceSha,
  tag,
}) {
  const identity = requireIdentity({ archiveName, repository, runId, sourceSha, tag });
  assertPlainObject(metadata, "release metadata");
  const state = releaseState(metadata);
  if (!["draft", "either", "published"].includes(expectedState)) {
    fail("INVALID_RELEASE_EXPECTATION", "expected release state is invalid");
  }
  if (expectedState !== "either" && state !== expectedState) {
    fail("RELEASE_STATE_MISMATCH", `release is ${state}, expected ${expectedState}`);
  }
  if (metadata.tagName !== tag || metadata.isPrerelease !== identity.isPrerelease) {
    fail("INVALID_RELEASE_METADATA", "release tag or prerelease state does not match strict SemVer identity");
  }
  if (metadata.author?.login !== "github-actions[bot]") {
    fail("RELEASE_OWNERSHIP_MISMATCH", "release was not created by the GitHub Actions identity");
  }
  if (!Array.isArray(metadata.assets)) fail("INVALID_RELEASE_METADATA", "release asset inventory is missing");
  const expectedNames = expectedReleaseAssetNames(archiveName);
  const assets = new Map();
  for (const asset of metadata.assets) {
    assertPlainObject(asset, "release asset metadata");
    if (typeof asset.name !== "string" || assets.has(asset.name)) {
      fail("INVALID_RELEASE_METADATA", "release asset names must be strings and unique");
    }
    if (!Number.isSafeInteger(asset.size) || asset.size < 2) {
      fail("INVALID_RELEASE_METADATA", `release asset size is invalid: ${asset.name}`);
    }
    assets.set(asset.name, asset);
  }
  if (JSON.stringify([...assets.keys()].sort()) !== JSON.stringify(expectedNames)) {
    fail("INVALID_RELEASE_METADATA", "release asset inventory does not match the sealed bundle");
  }
  if (expectedSizes) {
    for (const name of expectedNames) {
      if (assets.get(name).size !== expectedSizes.get(name)) {
        fail("INVALID_RELEASE_METADATA", `release asset size does not match downloaded bytes: ${name}`);
      }
    }
  }
  return Object.freeze({ identity, state });
}


export function validateReleaseBundleDirectory(rootPath, {
  archiveName,
  repository,
  runId,
  sourceSha,
  tag,
}) {
  const identity = requireIdentity({ archiveName, repository, runId, sourceSha, tag });
  const rootStat = lstatSync(rootPath);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    fail("INVALID_RELEASE_BUNDLE", "release bundle root must be a real directory");
  }
  const root = realpathSync(rootPath);
  const expectedNames = expectedReleaseAssetNames(archiveName);
  const entries = readdirSync(root, { withFileTypes: true });
  if (entries.some((entry) => !entry.isFile())
    || JSON.stringify(entries.map((entry) => entry.name).sort()) !== JSON.stringify(expectedNames)) {
    fail("INVALID_RELEASE_BUNDLE", "release bundle contains an unexpected entry");
  }

  const files = new Map();
  files.set("release-manifest.json", safeBundleFile(root, "release-manifest.json", LIMITS.manifest));
  const manifest = parseJson(files.get("release-manifest.json"), "release manifest");
  validateManifestOwner(manifest, { repository, runId, sourceSha, tag });
  validateBundleRecord(manifest.archive, archiveName, "release archive");
  validateBundleRecord(manifest.sbom, `${archiveName}.spdx.json`, "SPDX SBOM");
  validateBundleRecord(manifest.cyclonedx, `${archiveName}.cdx.json`, "CycloneDX SBOM");
  validateBundleRecord(manifest.verification, "release-verification.json", "release verification");
  assertExactKeys(manifest.policy, ["path", "sha256"], "release policy");
  if (manifest.policy.path !== "config/release-artifact-policy.json"
    || !SHA256.test(manifest.policy.sha256 ?? "")) {
    fail("INVALID_RELEASE_MANIFEST", "release policy identity is invalid");
  }

  const limits = new Map([
    [archiveName, LIMITS.archive],
    [`${archiveName}.sha256`, LIMITS.checksum],
    [`${archiveName}.cdx.json`, LIMITS.cyclonedx],
    [`${archiveName}.spdx.json`, LIMITS.sbom],
    ["release-verification.json", LIMITS.verification],
  ]);
  for (const [name, maximum] of limits) files.set(name, safeBundleFile(root, name, maximum));
  for (const record of [manifest.archive, manifest.sbom, manifest.cyclonedx, manifest.verification]) {
    const content = files.get(record.name);
    if (content.length !== record.bytes || sha256(content) !== record.sha256) {
      fail("RELEASE_ASSET_HASH_MISMATCH", `release asset does not match its sealed record: ${record.name}`);
    }
  }
  const expectedChecksum = `${manifest.archive.sha256}  ${archiveName}\n`;
  if (files.get(`${archiveName}.sha256`).toString("utf8") !== expectedChecksum) {
    fail("INVALID_RELEASE_CHECKSUM", "release checksum does not match the sealed archive");
  }
  validateSemanticAssets(files, manifest, identity);
  const sizes = new Map([...files].map(([name, content]) => [name, content.length]));
  return Object.freeze({ files, identity, manifest, sizes });
}


export function validateMatchingReleaseBundles({
  archiveName,
  localRoot,
  metadata,
  remoteRoot,
  repository,
  requireExactMatch = false,
  runId,
  sourceSha,
  tag,
}) {
  const options = { archiveName, repository, runId, sourceSha, tag };
  const local = validateReleaseBundleDirectory(localRoot, options);
  const remote = validateReleaseBundleDirectory(remoteRoot, options);
  const release = validateReleaseMetadata(metadata, {
    ...options,
    expectedSizes: remote.sizes,
    expectedState: "either",
  });
  if (!local.files.get(archiveName).equals(remote.files.get(archiveName))) {
    fail("REMOTE_RELEASE_MISMATCH", "remote release archive differs from this workflow run");
  }
  if (local.manifest.policy.sha256 !== remote.manifest.policy.sha256) {
    fail("REMOTE_RELEASE_MISMATCH", "remote release policy differs from this workflow run");
  }
  if (requireExactMatch) {
    for (const name of expectedReleaseAssetNames(archiveName)) {
      if (!local.files.get(name).equals(remote.files.get(name))) {
        fail("REMOTE_RELEASE_MISMATCH", `remote release asset differs from this workflow attempt: ${name}`);
      }
    }
  }
  return Object.freeze({ state: release.state });
}
