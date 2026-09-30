import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildProjectPortfolioSummary } from "../lib/change-observatory/portfolio-project-summary.mjs";
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

function storyPath(project, storyId, file = "story.json") {
  return path.join(project, ".sdlc", "stories", storyId, file);
}

function createStory(project, storyId) {
  mustRun([
    "story", "create",
    "--root", project,
    "--id", storyId,
    "--title", `Story ${storyId}`,
    "--acceptance", `Observable result for ${storyId}`,
    "--requirement", "REQ-001",
  ]);
}

function approveBreakdown(project, breakdownId, storyIds) {
  mustRun([
    "breakdown", "propose",
    "--root", project,
    "--id", breakdownId,
    "--requirement", "REQ-001",
    ...storyIds.flatMap((storyId) => ["--item", `story:${storyId}`]),
    "--rationale", `Split for ${breakdownId}`,
  ]);
  mustRun(["breakdown", "approve", "--root", project, "--id", breakdownId, ...humanApproval(`Approve ${breakdownId}`)]);
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

// Reproduces the planning state of the TravelOps trial: five approved stories
// chained by approved dependencies, abandoned in favour of one delivery story
// that nobody ever started.
function createTrialProject(name) {
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `sdlc-${name}-`)));
  projects.add(project);
  mustRun(["init", "--root", project, "--project-name", "Story closure fixture"]);
  const createdAt = new Date().toISOString();
  writeJson(path.join(project, ".sdlc", "requirements", "REQ-001.json"), {
    id: "REQ-001",
    kind: "requirement",
    schema_version: "requirement:v1",
    title: "Weekend itinerary",
    summary: "Plan and replan a weekend itinerary",
    status: "active",
    acceptance_criteria: ["An itinerary is produced for the requested weekend"],
    source_paths: [],
    proposal_ref: null,
    created_at: createdAt,
    updated_at: createdAt,
    audit: { fixture: true },
  });
  const planned = ["ST-001", "ST-002", "ST-003", "ST-004", "ST-005"];
  for (const storyId of planned) createStory(project, storyId);
  approveBreakdown(project, "BD-REQ-001", planned);
  approveDependencies(project, "DEP-REQ-001", [
    "ST-002:ST-001:blocks:implementation:validated",
    "ST-003:ST-002:blocks:implementation:validated",
    "ST-004:ST-003:blocks:implementation:validated",
    "ST-005:ST-001:blocks:implementation:validated",
  ]);
  createStory(project, "ST-MVP");
  approveBreakdown(project, "BD-REQ-001-R2", ["ST-MVP"]);
  return project;
}

function supersedePlannedStories(project) {
  return mustRunJson([
    "story", "supersede",
    "--root", project,
    "--from-breakdown", "BD-REQ-001",
    "--by", "ST-MVP",
    "--reason", "ST-MVP delivers the whole requirement in one release",
    ...humanApproval("Replace the five planned stories with ST-MVP"),
  ]);
}

test("abandoned breakdown stories keep status blocked until they are superseded", async () => {
  const project = createTrialProject("closure-trial");
  const portfolioBefore = await buildProjectPortfolioSummary(project);
  assert.equal(portfolioBefore.aggregates.activeWorkflows.count, 6);
  const before = mustRunJson(["status", "--root", project]);
  assert.equal(before.summary.blocked_work, 4);
  assert.equal(before.summary.completed_work, 0);
  assert.equal(before.summary.closed_work, 0);
  assert.equal(before.next_action.kind, "resolve_blocker");
  assert.equal(before.next_action.story_id, "ST-002");

  const storyBytes = Object.fromEntries(["ST-001", "ST-002", "ST-003", "ST-004", "ST-005"]
    .map((storyId) => [storyId, fs.readFileSync(storyPath(project, storyId))]));
  const result = supersedePlannedStories(project);
  assert.equal(result.status, "superseded");
  assert.deepEqual(result.stories, ["ST-001", "ST-002", "ST-003", "ST-004", "ST-005"]);
  assert.equal(result.replacement_id, "ST-MVP");
  assert.equal(result.breakdown_id, "BD-REQ-001");

  for (const [storyId, bytes] of Object.entries(storyBytes)) {
    assert.deepEqual(fs.readFileSync(storyPath(project, storyId)), bytes, `${storyId} story.json must not change`);
    const closure = readJson(storyPath(project, storyId, "closure.json"));
    assert.deepEqual(validateAgainstSchema(closure, "story-closure.schema.json", { schemaDir }).errors, []);
    assert.equal(closure.event, "superseded");
    assert.equal(closure.status, "superseded");
    assert.equal(closure.story_id, storyId);
    assert.equal(closure.replacement_id, "ST-MVP");
    assert.equal(closure.subject.breakdown.id, "BD-REQ-001");
    assert.equal(closure.approval.approval_source, "explicit-user");
    assert.equal(closure.approval.approved_by.type, "human");
  }
  const trace = fs.readFileSync(path.join(project, ".sdlc", "traces", "project.jsonl"), "utf8")
    .trim().split("\n").map((line) => JSON.parse(line));
  const closureEvent = trace.find((event) => event.action === "story.supersede");
  assert.ok(closureEvent, "the closure decision must be traced");
  assert.deepEqual(closureEvent.related, ["ST-001", "ST-002", "ST-003", "ST-004", "ST-005", "ST-MVP", "BD-REQ-001"]);
  assert.equal(closureEvent.evidence.length, 5);

  const after = mustRunJson(["status", "--root", project]);
  assert.equal(after.summary.blocked_work, 0);
  assert.equal(after.summary.available_work, 1);
  assert.equal(after.summary.closed_work, 5);
  assert.notEqual(after.next_action.kind, "resolve_blocker");
  const human = mustRun(["status", "--root", project]).stdout;
  assert.doesNotMatch(human, /cannot proceed/iu);
  assert.match(human, /closed_work: 5/u);

  const portfolioAfter = await buildProjectPortfolioSummary(project);
  assert.equal(portfolioAfter.aggregates.activeWorkflows.count, 1);

  const orchestration = mustRunJson(["orchestrate", "status", "--root", project]);
  assert.equal(orchestration.summary.closed, 5);
  for (const story of orchestration.stories.filter((item) => item.id !== "ST-MVP")) {
    assert.equal(story.orchestration_state, "closed", story.id);
    assert.equal(story.status, "superseded", story.id);
    assert.equal(story.lifecycle_source, "story_closure", story.id);
    assert.equal(story.closure.replacement_id, "ST-MVP", story.id);
    assert.deepEqual(story.blockers, [], story.id);
  }
  assert.equal(orchestration.stories.find((item) => item.id === "ST-MVP").orchestration_state, "available");
  const plan = mustRunJson(["orchestrate", "plan", "--root", project]);
  assert.deepEqual(plan.candidates.map((candidate) => candidate.story_id), ["ST-MVP"]);

  const deps = mustRunJson(["story", "deps", "--root", project, "--id", "ST-002"]);
  assert.deepEqual(deps.blockers, []);
  assert.deepEqual(deps.warnings, []);

  const breakdowns = mustRunJson(["breakdown", "status", "--root", project]).breakdowns;
  const planned = breakdowns.find((item) => item.id === "BD-REQ-001");
  assert.equal(planned.status, "approved");
  assert.deepEqual(planned.closed_stories.map((item) => item.story_id), ["ST-001", "ST-002", "ST-003", "ST-004", "ST-005"]);
  assert.deepEqual(breakdowns.find((item) => item.id === "BD-REQ-001-R2").closed_stories, []);

  const gate = JSON.parse(run(["gate", "check", "--root", project, "--json"]).stdout);
  assert.equal(gate.errors.concat(gate.warnings).some((item) => /ST-00[2-5] dependency/u.test(item)), false);

  mustFail([
    "story", "supersede",
    "--root", project,
    "--id", "ST-001",
    "--by", "ST-MVP",
    "--reason", "Again",
    ...humanApproval("Repeat"),
  ], /ST-001 is already superseded/u);

  const storyBytesBeforeWork = fs.readFileSync(storyPath(project, "ST-003"));
  mustFail([
    "contract", "create",
    "--root", project,
    "--story", "ST-003",
    "--phase", "implementation",
  ], /ST-003 was superseded by ST-MVP and cannot receive new work, so contract create is refused/u);
  mustFail([
    "workflow", "instance", "start",
    "--root", project,
    "--id", "DELIVERY-ST-003",
    "--definition", "software-project",
    "--definition-version", "3",
    "--story", "ST-003",
  ], /so workflow instance start is refused\. Continue the work on ST-MVP/u);
  mustFail([
    "trace", "append",
    "--root", project,
    "--story", "ST-003",
    "--type", "implementation",
    "--summary", "Late work",
  ], /so trace append is refused/u);
  mustFail([
    "story", "claim",
    "--root", project,
    "--id", "ST-003",
    "--agent", "codex",
  ], /terminal status 'superseded' and cannot be claimed/u);
  assert.deepEqual(fs.readFileSync(storyPath(project, "ST-003")), storyBytesBeforeWork);
  assert.equal(fs.existsSync(path.join(project, ".sdlc", "contracts", "contract-ST-003-implementation.json")), false);
});

test("a dependency on a superseded story follows its replacement", () => {
  const project = createTrialProject("closure-redirect");
  supersedePlannedStories(project);
  createStory(project, "ST-NEXT");
  approveDependencies(project, "DEP-NEXT", ["ST-NEXT:ST-002:blocks:implementation:validated"]);
  const deps = mustRunJson(["story", "deps", "--root", project, "--id", "ST-NEXT"]);
  assert.equal(deps.blockers.length, 1);
  assert.match(deps.blockers[0], /ST-NEXT depends on ST-002 \(superseded by ST-MVP\)/u);

  mustRun([
    "story", "cancel",
    "--root", project,
    "--id", "ST-MVP",
    "--reason", "The release was dropped",
    ...humanApproval("Drop the release story"),
  ]);
  const afterCancel = mustRunJson(["story", "deps", "--root", project, "--id", "ST-NEXT"]);
  assert.match(afterCancel.blockers[0], /ST-NEXT depends on ST-002, which was closed without a replacement/u);

  mustRun([
    "story", "cancel",
    "--root", project,
    "--id", "ST-NEXT",
    "--reason", "Nothing left to build on",
    ...humanApproval("Drop the follow-up"),
  ]);
  const status = mustRunJson(["status", "--root", project]);
  assert.equal(status.summary.available_work, 0);
  assert.equal(status.summary.blocked_work, 0);
  assert.equal(status.summary.closed_work, 7);
  assert.equal(status.next_action.kind, "none");
  assert.equal(status.next_action.reason, "no_operational_work");
});

test("closing refuses started work, unsafe replacements, and dependents left behind", () => {
  const project = createTrialProject("closure-refusals");

  writeJson(storyPath(project, "ST-005", "claim.json"), {
    story_id: "ST-005",
    agent: "fixture-agent",
    status: "released",
  });
  const started = mustFail([
    "story", "cancel",
    "--root", project,
    "--id", "ST-005",
    "--reason", "Out of scope",
    ...humanApproval("Cancel"),
  ], /ST-005 was already started: it has a work assignment/u);
  assert.match(`${started.stdout}\n${started.stderr}`, /nothing was changed/u);
  assert.equal(fs.existsSync(storyPath(project, "ST-005", "closure.json")), false);
  fs.rmSync(storyPath(project, "ST-005", "claim.json"));

  mustFail([
    "story", "cancel",
    "--root", project,
    "--id", "ST-003",
    "--reason", "Out of scope",
    ...humanApproval("Cancel"),
  ], /ST-004 depends on ST-003; close ST-004 too/u);
  mustRun([
    "story", "cancel",
    "--root", project,
    "--id", "ST-004",
    "--reason", "Out of scope",
    ...humanApproval("Cancel the last story first"),
  ]);
  mustRun([
    "story", "cancel",
    "--root", project,
    "--id", "ST-003",
    "--reason", "Out of scope",
    ...humanApproval("Then cancel its predecessor"),
  ]);

  mustFail([
    "story", "supersede",
    "--root", project,
    "--id", "ST-002",
    "--by", "ST-002",
    "--reason", "Self",
    ...humanApproval("Self"),
  ], /cannot supersede itself/u);
  mustFail([
    "story", "supersede",
    "--root", project,
    "--id", "ST-002",
    "--by", "ST-003",
    "--reason", "Closed replacement",
    ...humanApproval("Closed replacement"),
  ], /replacement story ST-003 is itself cancelled/u);
  mustFail([
    "story", "supersede",
    "--root", project,
    "--id", "ST-001",
    "--by", "ST-002",
    "--reason", "Replacement depends on it",
    ...humanApproval("Replacement depends on it"),
  ], /replacement ST-002 depends on ST-001, which it would supersede/u);
  mustFail([
    "story", "supersede",
    "--root", project,
    "--id", "ST-002",
    "--by", "ST-MVP",
    "--reason", "Agent decided alone",
    "--actor-type", "agent",
  ], /requires --actor-type human/u);
  mustFail([
    "story", "supersede",
    "--root", project,
    "--by", "ST-MVP",
    "--reason", "No target",
    ...humanApproval("No target"),
  ], /--id <story-id> or --from-breakdown <breakdown-id>/u, 2);
  mustFail([
    "story", "cancel",
    "--root", project,
    "--id", "ST-002",
    "--by", "ST-MVP",
    "--reason", "Wrong command",
    ...humanApproval("Wrong command"),
  ], /does not accept --by|Unknown option/u, 2);

  const status = mustRunJson(["status", "--root", project]);
  assert.equal(status.summary.closed_work, 2);
  const orchestration = mustRunJson(["orchestrate", "status", "--root", project]);
  assert.equal(orchestration.stories.find((item) => item.id === "ST-003").status, "cancelled");
  assert.equal(orchestration.stories.find((item) => item.id === "ST-003").closure.replacement_id, null);
});

test("a tampered closure or a story changed after closure fails closed", () => {
  const project = createTrialProject("closure-tamper");
  supersedePlannedStories(project);

  const closurePath = storyPath(project, "ST-002", "closure.json");
  const closureBytes = fs.readFileSync(closurePath);
  const closure = readJson(closurePath);
  closure.subject.reason = "Rewritten after approval";
  writeJson(closurePath, closure);
  let orchestration = mustRunJson(["orchestrate", "status", "--root", project]);
  let story = orchestration.stories.find((item) => item.id === "ST-002");
  assert.equal(story.orchestration_state, "blocked");
  assert.equal(story.lifecycle_source, "invalid_story_closure");
  assert.match(story.blockers.join("\n"), /invalid or unapproved story closure record/u);
  fs.writeFileSync(closurePath, closureBytes);

  const storyFile = storyPath(project, "ST-004");
  const record = readJson(storyFile);
  writeJson(storyFile, { ...record, title: "Retitled after closure" });
  orchestration = mustRunJson(["orchestrate", "status", "--root", project]);
  story = orchestration.stories.find((item) => item.id === "ST-004");
  assert.equal(story.orchestration_state, "blocked");
  assert.equal(story.lifecycle_source, "invalid_story_closure");
  assert.equal(orchestration.stories.find((item) => item.id === "ST-002").orchestration_state, "closed");
});
