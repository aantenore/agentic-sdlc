import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(repoRoot, "bin/agentic-sdlc.mjs");

function run(args, options = {}) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", timeout: 60_000, ...options });
}

function mustRun(args, options = {}) {
  const result = run(args, options);
  assert.equal(result.status, 0, `${args.join(" ")}\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  return result;
}

function mustFail(args, pattern, options = {}) {
  const result = run(args, options);
  assert.notEqual(result.status, 0, `${args.join(" ")} unexpectedly passed\n${result.stdout}`);
  const combined = `${result.stdout}\n${result.stderr}`;
  assert.match(combined, pattern, `${args.join(" ")}\n${combined}`);
  return result;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeArtifact(project, relativePath, body) {
  const filePath = path.join(project, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, body, "utf8");
  return relativePath;
}

function humanApproval(summary) {
  return ["--actor-type", "human", "--approval-source", "explicit-user", "--summary", summary];
}

function createProject(name) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `sdlc-${name}-`)));
  mustRun(["init", "--root", directory, "--project-name", "Operations phase fixture"]);
  return directory;
}

/**
 * Mints one real, schema-valid release-manifest record through the only command path that
 * produces one: an assessment proposal driven to completion. The budget declares no hard
 * limits, so completion needs no exact-metering usage receipts (see hardLimitMeteringCoverage
 * in bin/agentic-sdlc.mjs, which only requires coverage for limits that declare `hard`).
 */
function mintReleaseManifest(project, id) {
  const storyId = `ST-${id}`;
  const requirementId = `REQ-${id}`;
  const baselineId = `BASELINE-${id}`;
  const artifact = `.sdlc/stories/${storyId}/outputs/technical-assessment.md`;

  fs.writeFileSync(
    path.join(project, "README.md"),
    "# Operations phase fixture\n\nA minimal project used to mint a real release manifest.\n",
  );

  mustRun([
    "baseline", "propose", "--root", project, "--id", baselineId,
    "--source", "README.md", "--summary", "Current repository boundary",
  ]);
  mustRun([
    "baseline", "approve", "--root", project, "--id", baselineId,
    ...humanApproval("The baseline source and summary are accurate"),
  ]);

  const budget = {
    scope: { level: "proposal", proposal_id: id, includes_subagents: true },
    limits: {
      tokens: { unit: "tokens", metering: "estimated", soft: 200000 },
    },
  };
  const prepared = JSON.parse(mustRun([
    "assessment", "proposal", "prepare", "--root", project, "--id", id,
    "--baseline", baselineId, "--story", storyId, "--requirement", requirementId,
    "--scope-title", "Assess the operations phase fixture",
    "--scope-summary", "Produce a minimal, verifiable technical assessment artifact.",
    "--format", "Markdown", "--delivery", "artifact", "--artifact", artifact,
    "--budget-json", JSON.stringify(budget), "--json",
  ]).stdout);
  assert.equal(prepared.status, "proposal_pending");

  const approved = JSON.parse(mustRun([
    "assessment", "proposal", "approve", "--root", project, "--id", id,
    ...humanApproval("Approvo esattamente scope, write set, strumenti e budget mostrati"), "--json",
  ]).stdout);
  assert.equal(approved.status, "authorized");

  const applied = JSON.parse(mustRun([
    "assessment", "proposal", "apply", "--root", project, "--id", id,
    "--actor-type", "agent", "--trust-custom-rtk-command", "--json",
  ]).stdout);
  assert.equal(applied.status, "running");

  writeArtifact(
    project,
    artifact,
    [
      "# Technical assessment",
      "",
      "## Evidence",
      "The approved baseline shows a minimal, single-document repository.",
      "",
      "## Findings",
      "No further action is required for this fixture.",
      "",
    ].join("\n"),
  );

  mustRun([
    "output", "link", "--root", project, "--story", storyId,
    "--type", "technical-analysis", "--artifact", artifact,
    "--template", prepared.proposal.deliverable.template_id, "--mode", "new",
    "--requirement", requirementId, "--authorization", approved.authorization.id, "--json",
  ]);

  const completed = JSON.parse(mustRun([
    "assessment", "proposal", "complete", "--root", project, "--id", id,
    "--actor-type", "agent", "--trust-custom-rtk-command", "--json",
  ]).stdout);
  assert.equal(completed.status, "completed");
  assert.equal(completed.release_manifest.status, "released");
  return completed.release_manifest.id;
}

test("a story in the operations phase records incidents and feedback against a real release manifest", () => {
  const project = createProject("operations-phase");
  const releaseManifestId = mintReleaseManifest(project, "ASSESS-OPS-E2E");

  const storyId = "ST-OPS-E2E";
  mustRun([
    "story", "create", "--root", project, "--id", storyId,
    "--title", "Operate the released change", "--phase", "operations",
    "--acceptance", "Incidents and feedback are recorded against the release",
  ]);

  const emptyStoryId = "ST-OPS-EMPTY-E2E";
  mustRun([
    "story", "create", "--root", project, "--id", emptyStoryId,
    "--title", "Operate a second released change", "--phase", "operations",
    "--acceptance", "Nothing has been recorded yet",
  ]);

  const unknownManifestIncident = mustFail([
    "incident", "record", "--root", project, "--story", storyId,
    "--release-manifest", "RELEASE-DOES-NOT-EXIST",
    "--severity", "sev2", "--summary", "Should be refused", "--impact", "None; refused before write",
  ], /does not exist/);
  assert.equal(unknownManifestIncident.status, 1);
  assert.deepEqual(
    fs.readdirSync(path.join(project, ".sdlc", "operations")).filter((name) => name.endsWith(".json")),
    [],
    "a refused incident record must not be written",
  );

  const incident = JSON.parse(mustRun([
    "incident", "record", "--root", project, "--story", storyId,
    "--release-manifest", releaseManifestId,
    "--severity", "sev2", "--summary", "Checkout latency spike",
    "--impact", "5% of checkouts timed out for 20 minutes",
    "--incident-action", "Rolled back the checkout service",
    "--resolved-at", new Date().toISOString(),
    "--json",
  ]).stdout);
  assert.equal(incident.status, "recorded");
  assert.equal(incident.incident.kind, "incident");
  assert.equal(incident.incident.schema_version, "incident:v1");
  assert.equal(incident.incident.story_id, storyId);
  assert.equal(incident.incident.release_manifest_id, releaseManifestId);
  assert.equal(incident.incident.severity, "sev2");
  assert.equal(incident.incident.actions.length, 1);
  assert.ok(fs.existsSync(path.join(project, incident.incident_path)));

  const feedback = JSON.parse(mustRun([
    "feedback", "record", "--root", project, "--story", storyId,
    "--release-manifest", releaseManifestId,
    "--feedback-source", "monitoring", "--sentiment", "negative",
    "--summary", "Error rate rose after release",
    "--json",
  ]).stdout);
  assert.equal(feedback.status, "recorded");
  assert.equal(feedback.feedback.kind, "feedback");
  assert.equal(feedback.feedback.schema_version, "feedback:v1");
  assert.equal(feedback.feedback.story_id, storyId);
  assert.equal(feedback.feedback.release_manifest_id, releaseManifestId);
  assert.equal(feedback.feedback.source, "monitoring");
  assert.equal(feedback.feedback.sentiment, "negative");
  assert.ok(fs.existsSync(path.join(project, feedback.feedback_path)));

  const unknownManifestFeedback = mustFail([
    "feedback", "record", "--root", project, "--story", storyId,
    "--release-manifest", "RELEASE-DOES-NOT-EXIST",
    "--feedback-source", "user", "--summary", "Should be refused",
  ], /does not exist/);
  assert.equal(unknownManifestFeedback.status, 1);

  const gated = JSON.parse(mustRun([
    "gate", "check", "--root", project, "--story", storyId, "--json",
  ]).stdout);
  assert.equal(gated.status, "passed");
  assert.ok(gated.checked.some((line) => line === "1 incident record(s) for story ST-OPS-E2E"));
  assert.ok(gated.checked.some((line) => line === "1 feedback record(s) for story ST-OPS-E2E"));
  assert.ok(!gated.warnings.some((line) => line.includes(storyId) && line.includes("no incident or feedback")));

  const gatedEmpty = JSON.parse(mustRun([
    "gate", "check", "--root", project, "--story", emptyStoryId, "--json",
  ]).stdout);
  assert.equal(gatedEmpty.status, "passed");
  assert.ok(gatedEmpty.checked.some((line) => line === "0 incident record(s) for story ST-OPS-EMPTY-E2E"));
  assert.ok(gatedEmpty.checked.some((line) => line === "0 feedback record(s) for story ST-OPS-EMPTY-E2E"));
  assert.ok(gatedEmpty.warnings.some((line) =>
    line === `Story ${emptyStoryId} is in the operations phase with no incident or feedback records yet.`));
  assert.equal(gatedEmpty.errors.length, 0, "a warning must never become a blocking error");

  const gatedAll = JSON.parse(mustRun(["gate", "check", "--root", project, "--scope", "all", "--json"]).stdout);
  assert.equal(gatedAll.status, "passed");
  assert.ok(gatedAll.warnings.some((line) =>
    line === `Story ${emptyStoryId} is in the operations phase with no incident or feedback records yet.`));

  // Both records validate against their published schemas and are stored under .sdlc/operations/.
  const operationsRoot = path.join(project, ".sdlc", "operations");
  const recordNames = fs.readdirSync(operationsRoot).filter((name) => name.endsWith(".json"));
  assert.equal(recordNames.length, 2);
  const incidentOnDisk = readJson(path.join(operationsRoot, `${incident.incident.id}.json`));
  assert.equal(incidentOnDisk.record_hash, incident.incident.record_hash);
  const feedbackOnDisk = readJson(path.join(operationsRoot, `${feedback.feedback.id}.json`));
  assert.equal(feedbackOnDisk.record_hash, feedback.feedback.record_hash);
});
