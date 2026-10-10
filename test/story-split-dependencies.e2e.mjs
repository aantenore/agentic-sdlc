import "./helpers/test-isolation.mjs";

import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { validateAgainstSchema } from "../lib/json-schema-validator.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(repoRoot, "bin", "agentic-sdlc.mjs");
const schemaDir = path.join(repoRoot, "schemas");
const projects = new Set();

after(() => {
  if (process.env.AGENTIC_SDLC_KEEP_TEST_TMP === "1") return;
  for (const project of projects) fs.rmSync(project, { recursive: true, force: true });
});

function run(args) {
  const env = { ...process.env };
  for (const key of ["CI", "GITHUB_ACTIONS", "GITHUB_ACTOR", "CODEX_AGENT_NAME", "CODEX_USER_ID", "CLAUDECODE", "AGENTIC_SDLC_AGENT_HOST"]) {
    delete env[key];
  }
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env,
    timeout: 60_000,
    maxBuffer: 10 * 1024 * 1024,
  });
}

function mustRun(args) {
  const result = run(args);
  assert.equal(result.status, 0, `${args.join(" ")}\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  return result;
}

function mustRunJson(args) {
  return JSON.parse(mustRun([...args, "--json"]).stdout);
}

function mustFail(args, pattern, status = 1) {
  const result = run(args);
  const combined = `${result.stdout}\n${result.stderr}`;
  assert.equal(result.status, status, `${args.join(" ")}\n${combined}`);
  assert.match(combined, pattern, `${args.join(" ")}\n${combined}`);
  return result;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function humanApproval(summary) {
  return ["--actor-type", "human", "--approval-source", "explicit-user", "--summary", summary];
}

function sdlcPath(project, ...parts) {
  return path.join(project, ".sdlc", ...parts);
}

function createStory(project, storyId) {
  mustRun([
    "story", "create", "--no-derived-verification",
    "--root", project,
    "--id", storyId,
    "--title", `Story ${storyId}`,
    "--acceptance", `Observable result for ${storyId}`,
    "--requirement", "REQ-001",
  ]);
}

function approveDependencies(project, dependencyId, edges) {
  mustRun([
    "dependency", "propose",
    "--root", project,
    "--id", dependencyId,
    ...edges.flatMap((edge) => ["--edge", edge]),
  ]);
  mustRun(["dependency", "approve", "--root", project, "--id", dependencyId, ...humanApproval(`Approve ${dependencyId}`)]);
}

function deps(project, storyId) {
  return mustRunJson(["story", "deps", "--root", project, "--id", storyId]);
}

function statusStory(project, storyId) {
  return mustRunJson(["orchestrate", "status", "--root", project]).stories.find((story) => story.id === storyId);
}

// The TravelOps planning state: ST-ORCH-001 had approved dependents before it
// was split into a client (A), tools (B) and agents and orchestrator (C).
function createSplitProject(name) {
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `sdlc-${name}-`)));
  projects.add(project);
  mustRun(["init", "--root", project, "--project-name", "Story split fixture"]);
  const createdAt = new Date().toISOString();
  writeJson(sdlcPath(project, "requirements", "REQ-001.json"), {
    id: "REQ-001",
    kind: "requirement",
    schema_version: "requirement:v1",
    title: "Travel operations assistant",
    summary: "Chat, orchestration and improvement loop",
    status: "active",
    acceptance_criteria: ["A traveller can plan a trip through the chat"],
    source_paths: [],
    proposal_ref: null,
    created_at: createdAt,
    updated_at: createdAt,
    audit: { fixture: true },
  });
  for (const storyId of [
    "ST-ORCH-001", "ST-ORCH-001A", "ST-ORCH-001B", "ST-ORCH-001C",
    "ST-CHAT-001", "ST-CHAT-001A", "ST-CHAT-001C", "ST-IMPR-001",
  ]) {
    createStory(project, storyId);
  }
  approveDependencies(project, "DEP-REQ-001", [
    "ST-CHAT-001:ST-ORCH-001:blocks:analysis:merged",
    "ST-CHAT-001A:ST-ORCH-001:blocks:analysis:merged",
    "ST-CHAT-001C:ST-ORCH-001:blocks:analysis:merged",
    "ST-IMPR-001:ST-ORCH-001:blocks:analysis:merged",
  ]);
  return project;
}

test("a story split into several stories leaves its dependents for a person to review", () => {
  const project = createSplitProject("story-split");
  const approvedProposal = fs.readFileSync(sdlcPath(project, "dependencies", "DEP-REQ-001.json"));

  const result = mustRunJson([
    "story", "supersede",
    "--root", project,
    "--id", "ST-ORCH-001",
    "--by", "ST-ORCH-001C",
    "--by", "ST-ORCH-001A",
    "--by", "ST-ORCH-001B",
    "--reason", "Split into client, tools, and agents with the orchestrator",
    ...humanApproval("Split the orchestration story in three"),
  ]);
  assert.equal(result.status, "superseded");
  assert.equal(result.replacement_id, null);
  assert.deepEqual(result.replacement_ids, ["ST-ORCH-001A", "ST-ORCH-001B", "ST-ORCH-001C"]);
  // Point 3: the dependents are listed with the commands that review them.
  assert.deepEqual(result.dependents.map((item) => item.story_id), ["ST-CHAT-001", "ST-CHAT-001A", "ST-CHAT-001C", "ST-IMPR-001"]);
  assert.ok(result.dependents.every((item) => item.effect === "needs_review" && item.depends_on === "ST-ORCH-001"));
  assert.equal(result.dependency_review.required, true);
  assert.match(result.dependency_review.commands[0], /^agentic-sdlc dependency revise --id DEP-REV-ST-ORCH-001 /u);
  assert.match(result.dependency_review.commands[0], /--redirect ST-CHAT-001A:ST-ORCH-001:<ST-ORCH-001A\|ST-ORCH-001B\|ST-ORCH-001C>/u);
  assert.match(result.dependency_review.commands[1], /^agentic-sdlc dependency approve --id DEP-REV-ST-ORCH-001 /u);

  const closure = readJson(sdlcPath(project, "stories", "ST-ORCH-001", "closure.json"));
  assert.deepEqual(validateAgainstSchema(closure, "story-closure.schema.json", { schemaDir }).errors, []);
  assert.equal(closure.schema_version, "story-closure:v2");
  assert.equal(closure.replacement_id, null);
  assert.deepEqual(closure.replacement_ids, ["ST-ORCH-001A", "ST-ORCH-001B", "ST-ORCH-001C"]);
  assert.deepEqual(closure.subject.replacements.map((ref) => ref.id), closure.replacement_ids);
  assert.ok(fs.existsSync(sdlcPath(project, "compatibility", "story-closure-multiple-replacements.json")),
    "older plugins are told to update before reading the split");

  const human = mustRun(["story", "deps", "--root", project, "--id", "ST-CHAT-001A"]).stdout;
  assert.match(human, /BLOCKER ST-CHAT-001A depends on ST-ORCH-001, which was split into ST-ORCH-001A, ST-ORCH-001B, ST-ORCH-001C/u);

  // Point 2: no silent redirection onto the first replacement.
  const chat = deps(project, "ST-CHAT-001A");
  assert.equal(chat.blockers.length, 1);
  assert.match(chat.blockers[0], /a person must decide which of them ST-CHAT-001A depends on/u);
  assert.match(chat.blockers[0], /dependency revise --id <revision-id> --redirect ST-CHAT-001A:ST-ORCH-001:<ST-ORCH-001A\|ST-ORCH-001B\|ST-ORCH-001C>/u);
  assert.doesNotMatch(chat.blockers[0], /superseded by ST-ORCH-001A/u);
  assert.equal(statusStory(project, "ST-CHAT-001A").orchestration_state, "blocked");
  assert.equal(statusStory(project, "ST-ORCH-001").orchestration_state, "closed");
  assert.deepEqual(statusStory(project, "ST-ORCH-001").closure.replacement_ids, ["ST-ORCH-001A", "ST-ORCH-001B", "ST-ORCH-001C"]);
  mustFail([
    "contract", "create",
    "--root", project,
    "--story", "ST-ORCH-001",
    "--phase", "implementation",
  ], /ST-ORCH-001 was superseded by ST-ORCH-001A, ST-ORCH-001B, ST-ORCH-001C .*Continue the work on the replacement that covers it/u);

  // The change request that added edges to the orchestrator part.
  approveDependencies(project, "DEP-CR-001-SPLIT-ORCH", [
    "ST-CHAT-001C:ST-ORCH-001C:blocks:analysis:merged",
    "ST-IMPR-001:ST-ORCH-001C:blocks:analysis:merged",
  ]);
  const improvement = deps(project, "ST-IMPR-001");
  assert.equal(improvement.blockers.length, 2, improvement.blockers.join("\n"));
  assert.ok(improvement.blockers.some((item) => /which was split into/u.test(item)), "the old edge still waits for review");
  assert.ok(improvement.blockers.some((item) => /^ST-IMPR-001 depends on ST-ORCH-001C \[draft \(design\), not claimed\] \(blocks, analysis, requires merged\)$/u.test(item)),
    improvement.blockers.join("\n"));

  // Point 4: a revision is only a proposal until a person approves it.
  const graphPath = sdlcPath(project, "dependencies", "graph.json");
  const graphBeforeRevision = fs.readFileSync(graphPath);
  const proposed = mustRunJson([
    "dependency", "revise",
    "--root", project,
    "--id", "DEP-REV-ST-ORCH-001",
    "--redirect", "ST-CHAT-001A:ST-ORCH-001:ST-ORCH-001A",
    "--redirect", "ST-CHAT-001A:ST-ORCH-001:ST-ORCH-001C",
    "--redirect", "ST-CHAT-001:ST-ORCH-001:ST-ORCH-001A",
    "--retire", "ST-CHAT-001C:ST-ORCH-001",
    "--retire", "ST-IMPR-001:ST-ORCH-001",
    "--rationale", "Each chat story names the part it needs; the change request already covers the rest",
  ]);
  assert.equal(proposed.status, "proposed");
  assert.equal(proposed.dependency.kind, "dependency_revision");
  assert.deepEqual(proposed.dependency.retire.map((edge) => `${edge.from}>${edge.to}`).sort(), [
    "ST-CHAT-001>ST-ORCH-001", "ST-CHAT-001A>ST-ORCH-001", "ST-CHAT-001C>ST-ORCH-001", "ST-IMPR-001>ST-ORCH-001",
  ]);
  assert.deepEqual(proposed.dependency.edges.map((edge) => `${edge.from}>${edge.to}`).sort(), [
    "ST-CHAT-001>ST-ORCH-001A", "ST-CHAT-001A>ST-ORCH-001A", "ST-CHAT-001A>ST-ORCH-001C",
  ]);
  assert.ok(proposed.dependency.edges.every((edge) => edge.required_state === "merged" && edge.blocks === "analysis"));
  assert.deepEqual(fs.readFileSync(graphPath), graphBeforeRevision, "a proposed revision changes nothing");
  assert.match(deps(project, "ST-CHAT-001A").blockers[0], /which was split into/u);
  const pending = mustRunJson(["approval", "requests", "--root", project]);
  assert.ok(JSON.stringify(pending).includes("DEP-REV-ST-ORCH-001"), "the revision waits for approval");

  mustFail([
    "dependency", "approve",
    "--root", project,
    "--id", "DEP-REV-ST-ORCH-001",
    "--actor-type", "agent",
  ], /requires --actor-type human/u);
  assert.deepEqual(fs.readFileSync(graphPath), graphBeforeRevision);

  const approved = mustRunJson([
    "dependency", "approve",
    "--root", project,
    "--id", "DEP-REV-ST-ORCH-001",
    ...humanApproval("Point each dependent at the part it needs"),
  ]);
  assert.equal(approved.status, "approved");
  assert.deepEqual(fs.readFileSync(sdlcPath(project, "dependencies", "DEP-REQ-001.json")), approvedProposal,
    "the approved proposal is never rewritten");
  const graph = readJson(graphPath);
  const retired = graph.edges.filter((edge) => edge.status === "retired");
  assert.deepEqual(retired.map((edge) => edge.from).sort(), ["ST-CHAT-001", "ST-CHAT-001A", "ST-CHAT-001C", "ST-IMPR-001"]);
  assert.ok(retired.every((edge) => edge.to === "ST-ORCH-001"
    && edge.proposal_id === "DEP-REQ-001"
    && edge.retired_by_revision === "DEP-REV-ST-ORCH-001"
    && edge.retired_by?.type === "human"));
  const redirected = graph.edges.find((edge) => edge.from === "ST-CHAT-001A" && edge.to === "ST-ORCH-001C");
  assert.equal(redirected.proposal_id, "DEP-REV-ST-ORCH-001");
  assert.equal(redirected.revises.proposal_id, "DEP-REQ-001");
  const trace = fs.readFileSync(sdlcPath(project, "traces", "project.jsonl"), "utf8")
    .trim().split("\n").map((line) => JSON.parse(line));
  const revisionEvent = trace.find((event) => event.action === "dependency.revise");
  assert.ok(revisionEvent, "the revision decision is traced");
  assert.ok(revisionEvent.related.includes("ST-ORCH-001") && revisionEvent.related.includes("ST-CHAT-001A"));

  // Retired edges are no longer evaluated anywhere.
  const chatAfter = deps(project, "ST-CHAT-001A");
  assert.deepEqual(chatAfter.edges.map((edge) => edge.to).sort(), ["ST-ORCH-001A", "ST-ORCH-001C"]);
  assert.equal(chatAfter.blockers.length, 2);
  assert.ok(chatAfter.blockers.every((item) => !/ST-ORCH-001[^A-C]|split/u.test(item)), chatAfter.blockers.join("\n"));
  const improvementAfter = deps(project, "ST-IMPR-001");
  assert.deepEqual(improvementAfter.edges.map((edge) => edge.to), ["ST-ORCH-001C"]);
  assert.equal(improvementAfter.blockers.length, 1);
  const chain = mustRunJson(["story", "deps", "--root", project, "--id", "ST-CHAT-001C", "--transitive"]);
  assert.deepEqual(chain.chain.map((link) => link.to), ["ST-ORCH-001C"]);
  const gate = JSON.parse(run(["gate", "check", "--root", project, "--story", "ST-IMPR-001", "--json"]).stdout);
  assert.equal(gate.errors.concat(gate.warnings).some((item) => /depends on ST-ORCH-001 /u.test(item)), false,
    gate.errors.concat(gate.warnings).join("\n"));
  const observatoryEdges = graph.edges.filter((edge) => !edge.status || edge.status === "approved");
  assert.equal(observatoryEdges.some((edge) => edge.to === "ST-ORCH-001"), false);

  // Approving the original proposal again never brings a retired edge back.
  mustRun(["dependency", "approve", "--root", project, "--id", "DEP-REQ-001", ...humanApproval("Re-approve")]);
  assert.equal(readJson(graphPath).edges.filter((edge) => edge.status === "retired").length, 4);
  assert.deepEqual(deps(project, "ST-CHAT-001A").edges.map((edge) => edge.to).sort(), ["ST-ORCH-001A", "ST-ORCH-001C"]);

  // A retired edge cannot be retired again, and a stale revision writes nothing.
  mustFail([
    "dependency", "revise",
    "--root", project,
    "--id", "DEP-REV-AGAIN",
    "--retire", "ST-IMPR-001:ST-ORCH-001",
    "--rationale", "Again",
  ], /no active approved dependency ST-IMPR-001 -> ST-ORCH-001 to retire/u);
  mustRun([
    "dependency", "revise", "--root", project, "--id", "DEP-REV-FIRST",
    "--retire", "ST-CHAT-001:ST-ORCH-001A", "--rationale", "First",
  ]);
  mustRun([
    "dependency", "revise", "--root", project, "--id", "DEP-REV-SECOND",
    "--redirect", "ST-CHAT-001:ST-ORCH-001A:ST-ORCH-001B", "--rationale", "Second",
  ]);
  mustRun(["dependency", "approve", "--root", project, "--id", "DEP-REV-FIRST", ...humanApproval("First")]);
  const graphBeforeStale = fs.readFileSync(graphPath);
  mustFail(["dependency", "approve", "--root", project, "--id", "DEP-REV-SECOND", ...humanApproval("Second")],
    /retires ST-CHAT-001 -> ST-ORCH-001A .*no longer an active approved dependency; nothing was changed/u);
  assert.deepEqual(fs.readFileSync(graphPath), graphBeforeStale);
  assert.equal(readJson(sdlcPath(project, "dependencies", "DEP-REV-SECOND.json")).status, "proposed");
  mustFail([
    "dependency", "revise", "--root", project, "--id", "DEP-REV-BAD",
    "--redirect", "ST-CHAT-001A:ST-ORCH-001A:ST-NOPE", "--rationale", "Typo",
  ], /story ST-NOPE does not exist/u);
  mustFail(["dependency", "revise", "--root", project, "--id", "DEP-REV-EMPTY", "--rationale", "Nothing"],
    /needs at least one --retire, --redirect or --edge/u, 2);
});

test("a dependency names the story it effectively waits on and where that story stands", () => {
  const project = createSplitProject("story-split-single");
  // The client part is being worked on: its active claim names the agent.
  writeJson(sdlcPath(project, "stories", "ST-ORCH-001A", "claim.json"), {
    story_id: "ST-ORCH-001A",
    agent: "agente-orch-001a",
    status: "active",
  });
  const result = mustRunJson([
    "story", "supersede",
    "--root", project,
    "--id", "ST-ORCH-001",
    "--by", "ST-ORCH-001A",
    "--reason", "The client story now delivers the orchestration work",
    ...humanApproval("Replace the orchestration story with its client part"),
  ]);
  // One replacement keeps the version 1 closure and follows it, as before.
  assert.equal(result.replacement_id, "ST-ORCH-001A");
  const closure = readJson(sdlcPath(project, "stories", "ST-ORCH-001", "closure.json"));
  assert.equal(closure.schema_version, "story-closure:v1");
  assert.equal(closure.replacement_id, "ST-ORCH-001A");
  assert.equal(Object.hasOwn(closure, "replacement_ids"), false);
  assert.equal(Object.hasOwn(closure.subject, "replacements"), false);
  assert.equal(result.dependency_review.required, false);
  assert.ok(result.dependents.every((item) => item.effect === "follows_replacement" && item.follows === "ST-ORCH-001A"));

  const chat = deps(project, "ST-CHAT-001A");
  assert.equal(chat.blockers.length, 1);
  assert.match(
    chat.blockers[0],
    /^ST-CHAT-001A depends on ST-ORCH-001 → superseded by ST-ORCH-001A \[in progress \(design\), claimed by agente-orch-001a\] \(blocks, analysis, requires merged\)$/u,
  );
  const human = mustRun(["status", "--root", project, "--json"]).stdout;
  assert.match(human, /superseded by ST-ORCH-001A \[in progress/u);
  assert.equal(fs.existsSync(sdlcPath(project, "compatibility", "story-closure-multiple-replacements.json")), false);
});
