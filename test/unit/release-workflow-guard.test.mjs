import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  expectedReleaseAssetNames,
  parseReleaseTag,
  ReleaseWorkflowGuardError,
  validateReleaseBundleDirectory,
  validateMatchingReleaseBundles,
  validateReleaseMetadata,
} from "../../lib/release/workflow-guard.mjs";


const IDENTITY = Object.freeze({
  archiveName: "agentic-sdlc-1.2.3+Build-Meta-with-hyphen.tgz",
  repository: "aantenore/agentic-sdlc",
  runId: "123456789",
  sourceSha: "a".repeat(40),
  tag: "v1.2.3+Build-Meta-with-hyphen",
});


function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}


function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}


function createBundle(root) {
  mkdirSync(root);
  const archive = Buffer.from("verified release archive\n");
  const spdx = Buffer.from(`${JSON.stringify({
    spdxVersion: "SPDX-2.3",
    dataLicense: "CC0-1.0",
    packages: [{ name: "agentic-sdlc" }],
  })}\n`);
  const cyclonedx = Buffer.from(`${JSON.stringify({
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    components: [{ name: "agentic-sdlc" }],
  })}\n`);
  const verification = Buffer.from(`${JSON.stringify({
    status: "passed",
    package: {
      name: "agentic-sdlc",
      version: "1.2.3+Build-Meta-with-hyphen",
      tag: IDENTITY.tag,
    },
    artifact: { sha256: sha256(archive) },
    smoke: {
      npm_install: "passed",
      cli_help: "passed",
      doctor: "passed",
      installer_plan: "passed",
      installer_zero_write: true,
      installer_v2_plan: "passed",
      installer_v2_zero_write: true,
    },
  })}\n`);
  const assets = new Map([
    [IDENTITY.archiveName, archive],
    [`${IDENTITY.archiveName}.spdx.json`, spdx],
    [`${IDENTITY.archiveName}.cdx.json`, cyclonedx],
    ["release-verification.json", verification],
  ]);
  for (const [name, content] of assets) writeFileSync(path.join(root, name), content);
  writeFileSync(
    path.join(root, `${IDENTITY.archiveName}.sha256`),
    `${sha256(archive)}  ${IDENTITY.archiveName}\n`,
  );
  writeJson(path.join(root, "release-manifest.json"), {
    schema_version: "agentic-sdlc.release-bundle.v1",
    repository: IDENTITY.repository,
    tag: IDENTITY.tag,
    source_sha: IDENTITY.sourceSha,
    producer: {
      schema_version: "agentic-sdlc.github-actions-release-owner.v1",
      workflow_path: ".github/workflows/release.yml",
      run_id: IDENTITY.runId,
    },
    archive: { name: IDENTITY.archiveName, bytes: archive.length, sha256: sha256(archive) },
    sbom: {
      name: `${IDENTITY.archiveName}.spdx.json`,
      bytes: spdx.length,
      sha256: sha256(spdx),
    },
    cyclonedx: {
      name: `${IDENTITY.archiveName}.cdx.json`,
      bytes: cyclonedx.length,
      sha256: sha256(cyclonedx),
    },
    verification: {
      name: "release-verification.json",
      bytes: verification.length,
      sha256: sha256(verification),
    },
    policy: { path: "config/release-artifact-policy.json", sha256: "f".repeat(64) },
  });
}


function releaseMetadata(root, isDraft) {
  return {
    author: { login: "github-actions[bot]" },
    tagName: IDENTITY.tag,
    isDraft,
    isPrerelease: false,
    assets: expectedReleaseAssetNames(IDENTITY.archiveName).map((name) => ({
      name,
      size: statSync(path.join(root, name)).size,
    })),
  };
}


test("parses complete SemVer tags and derives prerelease only from the parsed field", () => {
  assert.deepEqual(parseReleaseTag("v1.2.3-RC.1+Build-Meta-with-hyphen"), {
    tag: "v1.2.3-RC.1+Build-Meta-with-hyphen",
    version: "1.2.3-RC.1+Build-Meta-with-hyphen",
    prerelease: "RC.1",
    build: "Build-Meta-with-hyphen",
    isPrerelease: true,
  });
  assert.deepEqual(parseReleaseTag("v1.2.3+Build-Meta-with-hyphen"), {
    tag: "v1.2.3+Build-Meta-with-hyphen",
    version: "1.2.3+Build-Meta-with-hyphen",
    prerelease: null,
    build: "Build-Meta-with-hyphen",
    isPrerelease: false,
  });
});


test("rejects tags outside strict SemVer", () => {
  for (const tag of [
    "1.2.3",
    "v01.2.3",
    "v1.2.3-01",
    "v1.2.3+",
    "v1.2.3+build..one",
    "v1.2",
    "v1.2.3\nnext",
  ]) {
    assert.throws(
      () => parseReleaseTag(tag),
      (error) => error instanceof ReleaseWorkflowGuardError && error.code === "INVALID_RELEASE_TAG",
      tag,
    );
  }
});


test("accepts an exact workflow-owned draft or already-published bundle", (t) => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), "release-workflow-guard-"));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const localRoot = path.join(temporary, "local");
  const remoteRoot = path.join(temporary, "remote");
  createBundle(localRoot);
  cpSync(localRoot, remoteRoot, { recursive: true });

  for (const isDraft of [true, false]) {
    const result = validateMatchingReleaseBundles({
      ...IDENTITY,
      localRoot,
      metadata: releaseMetadata(remoteRoot, isDraft),
      remoteRoot,
    });
    assert.equal(result.state, isDraft ? "draft" : "published");
  }

  const sbomName = `${IDENTITY.archiveName}.spdx.json`;
  const remoteSbom = Buffer.from(`${JSON.stringify({
    spdxVersion: "SPDX-2.3",
    dataLicense: "CC0-1.0",
    documentNamespace: "https://example.invalid/rerun-specific-sbom",
    packages: [{ name: "agentic-sdlc" }],
  })}\n`);
  writeFileSync(path.join(remoteRoot, sbomName), remoteSbom);
  const manifestPath = path.join(remoteRoot, "release-manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.sbom.bytes = remoteSbom.length;
  manifest.sbom.sha256 = sha256(remoteSbom);
  writeJson(manifestPath, manifest);

  const recoveredPublished = validateMatchingReleaseBundles({
    ...IDENTITY,
    localRoot,
    metadata: releaseMetadata(remoteRoot, false),
    remoteRoot,
  });
  assert.equal(recoveredPublished.state, "published");
  assert.throws(
    () => validateMatchingReleaseBundles({
      ...IDENTITY,
      localRoot,
      metadata: releaseMetadata(remoteRoot, false),
      remoteRoot,
      requireExactMatch: true,
    }),
    (error) => error instanceof ReleaseWorkflowGuardError
      && error.code === "REMOTE_RELEASE_MISMATCH",
  );
});


test("requires both installer v2 read-only gates in the sealed verification", (t) => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), "release-workflow-v2-gates-"));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));

  for (const [field, value] of [
    ["installer_v2_plan", "not_run"],
    ["installer_v2_zero_write", false],
  ]) {
    const root = path.join(temporary, field);
    createBundle(root);
    const verificationPath = path.join(root, "release-verification.json");
    const verification = JSON.parse(readFileSync(verificationPath, "utf8"));
    verification.smoke[field] = value;
    writeJson(verificationPath, verification);

    const verificationBytes = readFileSync(verificationPath);
    const manifestPath = path.join(root, "release-manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.verification.bytes = verificationBytes.length;
    manifest.verification.sha256 = sha256(verificationBytes);
    writeJson(manifestPath, manifest);

    assert.throws(
      () => validateReleaseBundleDirectory(root, IDENTITY),
      (error) => error instanceof ReleaseWorkflowGuardError
        && error.code === "INVALID_RELEASE_VERIFICATION",
      field,
    );
  }
});


test("rejects tampering of every remote release asset before recovery", (t) => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), "release-workflow-tamper-"));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const localRoot = path.join(temporary, "local");
  const remoteRoot = path.join(temporary, "remote");
  createBundle(localRoot);
  cpSync(localRoot, remoteRoot, { recursive: true });

  for (const name of expectedReleaseAssetNames(IDENTITY.archiveName)) {
    const file = path.join(remoteRoot, name);
    const original = readFileSync(file);
    writeFileSync(file, Buffer.concat([original, Buffer.from("tampered\n")]));
    assert.throws(
      () => validateMatchingReleaseBundles({
        ...IDENTITY,
        localRoot,
        metadata: releaseMetadata(remoteRoot, true),
        remoteRoot,
      }),
      (error) => error instanceof ReleaseWorkflowGuardError,
      name,
    );
    writeFileSync(file, original);
  }
});


test("requires exact workflow-run ownership and strict metadata before recovery", (t) => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), "release-workflow-owner-"));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const localRoot = path.join(temporary, "local");
  const remoteRoot = path.join(temporary, "remote");
  createBundle(localRoot);
  cpSync(localRoot, remoteRoot, { recursive: true });

  const manifestPath = path.join(remoteRoot, "release-manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.producer.run_id = "987654321";
  writeJson(manifestPath, manifest);
  assert.throws(
    () => validateMatchingReleaseBundles({
      ...IDENTITY,
      localRoot,
      metadata: releaseMetadata(remoteRoot, true),
      remoteRoot,
    }),
    (error) => error instanceof ReleaseWorkflowGuardError
      && error.code === "RELEASE_OWNERSHIP_MISMATCH",
  );

  const metadata = releaseMetadata(localRoot, true);
  metadata.isPrerelease = true;
  assert.throws(
    () => validateReleaseMetadata(metadata, { ...IDENTITY, expectedState: "draft" }),
    (error) => error instanceof ReleaseWorkflowGuardError
      && error.code === "INVALID_RELEASE_METADATA",
  );
  metadata.isPrerelease = false;
  metadata.author.login = "unexpected-user";
  assert.throws(
    () => validateReleaseMetadata(metadata, { ...IDENTITY, expectedState: "draft" }),
    (error) => error instanceof ReleaseWorkflowGuardError
      && error.code === "RELEASE_OWNERSHIP_MISMATCH",
  );
});
