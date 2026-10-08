import test, { after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { AGENT_HOSTS, AGENT_HOST_OVERRIDE_ENV } from "../../lib/agent-host.mjs";
import { sealTraceEvent } from "../../lib/trace-integrity.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const cliPath = path.join(repoRoot, "bin", "agentic-sdlc.mjs");
const tempProjects = new Set();

after(() => {
  if (process.env.AGENTIC_SDLC_KEEP_TEST_TMP === "1") return;
  for (const project of tempProjects) {
    fs.rmSync(project, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
  tempProjects.clear();
});

// Attribution must not depend on the host that runs the tests, so every
// variable the agent-host registry reads is removed from the child process.
const HOST_ENVIRONMENT_KEYS = [
  AGENT_HOST_OVERRIDE_ENV,
  ...AGENT_HOSTS.flatMap((host) => [...host.markers, ...Object.values(host.env).filter(Boolean)]),
];

function runCli(args, options = {}) {
  const env = { ...process.env };
  for (const key of ["CI", "GITHUB_ACTIONS", "GITHUB_ACTOR", "NODE_OPTIONS", ...HOST_ENVIRONMENT_KEYS]) {
    delete env[key];
  }
  Object.assign(env, options.env || {});
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: options.cwd || repoRoot,
    encoding: "utf8",
    env,
    timeout: options.timeout || 30_000,
    maxBuffer: 10 * 1024 * 1024,
  });
}

function mustRun(args, options = {}) {
  const result = runCli(args, options);
  assert.equal(result.error, undefined, `${args.join(" ")} failed to execute: ${result.error?.message}`);
  assert.equal(result.status, 0, `${args.join(" ")}\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  return result;
}

function mustFail(args, options = {}) {
  const result = runCli(args, options);
  assert.equal(result.error, undefined, `${args.join(" ")} failed to execute: ${result.error?.message}`);
  assert.notEqual(result.status, 0, `${args.join(" ")} unexpectedly passed\n${result.stdout}`);
  return result;
}

function json(result) {
  return JSON.parse(result.stdout || result.stderr);
}

function initializedProject(name) {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), `agentic-sdlc-trace-status-${name}-`));
  tempProjects.add(project);
  mustRun(["init", "--root", project, "--project-name", "Trace status fixture", "--force", "--json"]);
  return project;
}

function appendDecision(project, summary, extra = []) {
  return mustRun([
    "trace", "append", "--root", project, "--type", "decision", "--summary", summary, ...extra, "--json",
  ]);
}

const projectTrace = (project) => path.join(project, ".sdlc", "traces", "project.jsonl");

test("a missing project configuration fails closed instead of dropping custom redaction", () => {
  const project = initializedProject("missing-config");
  addConfiguredPiiPattern(project, "EMP-[0-9]{6}");
  confirmConfiguration(project);
  appendDecision(project, "before the configuration disappeared");
  const configPath = path.join(project, ".sdlc", "config.json");
  fs.rmSync(configPath);
  const traceBefore = fs.readFileSync(projectTrace(project), "utf8");

  const append = mustFail([
    "trace", "append", "--root", project, "--type", "decision", "--summary", "must not be written", "--json",
  ]);
  const payload = json(append);
  assert.equal(payload.error.code, "CONFIG_MISSING");
  assert.match(payload.error.message, /\.sdlc\/config\.json is missing/u);
  assert.match(payload.error.message, /Restore \.sdlc\/config\.json from version control/u);
  assert.equal(fs.readFileSync(projectTrace(project), "utf8"), traceBefore);

  const status = mustFail(["status", "--root", project]);
  assert.match(status.stderr, /saved rules are missing/u);
  assert.match(status.stderr, /Next step: Restore \.sdlc\/config\.json/u);

  const statusIt = mustFail(["status", "--root", project, "--locale", "it"]);
  assert.match(statusIt.stderr, /Prossimo passo: Ripristina \.sdlc\/config\.json/u);

  const doctor = mustFail(["doctor", "--root", project, "--json"]);
  const effective = json(doctor).checks.find((check) => check.id === "effective-config");
  assert.equal(effective.status, "failed");
  assert.match(effective.details, /config\.json is missing/u);

  const migrate = mustFail(["config", "migrate", "--root", project, "--json"]);
  assert.equal(json(migrate).error.code, "CONFIG_MISSING");

  const verify = json(mustRun(["trace", "verify", "--root", project, "--json"]));
  assert.equal(verify.status, "verified");
  assert.doesNotMatch(JSON.stringify(verify), /before the configuration disappeared/u);
});

test("a missing configuration that held only the defaults names the exact restore copy", () => {
  const project = initializedProject("missing-default-config");
  fs.rmSync(path.join(project, ".sdlc", "config.json"));
  const failure = json(mustFail(["status", "--root", project, "--json"]));
  assert.equal(failure.error.code, "CONFIG_MISSING");
  const match = /restore it by copying "([^"]+)" to \.sdlc\/config\.json/u.exec(failure.error.message);
  assert.ok(match, failure.error.message);
  assert.equal(path.basename(match[1]), "sdlc-config.json");
  fs.copyFileSync(match[1], path.join(project, ".sdlc", "config.json"));
  mustRun(["doctor", "--root", project, "--json"]);
  mustRun(["status", "--root", project, "--json"]);
});

function tamperProjectTrace(project, from, to) {
  const tracePath = projectTrace(project);
  const original = fs.readFileSync(tracePath, "utf8");
  assert.ok(original.includes(from), "fixture text must be present before tampering");
  fs.writeFileSync(tracePath, original.replace(from, to));
}

test("trace verify reports intact and tampered history with a non-zero exit and recovery steps", () => {
  const project = initializedProject("verify");
  appendDecision(project, "Original decision wording");

  const clean = mustRun(["trace", "verify", "--root", project, "--json"]);
  const cleanPayload = json(clean);
  assert.equal(cleanPayload.status, "verified");
  assert.equal(cleanPayload.violations, 0);
  assert.equal(cleanPayload.files[0].path, ".sdlc/traces/project.jsonl");
  assert.equal(cleanPayload.authenticity_claimed, false);

  tamperProjectTrace(project, "Original decision wording", "Rewritten decision wording");
  const tampered = mustFail(["trace", "verify", "--root", project, "--json"]);
  assert.equal(tampered.status, 1);
  const payload = json(tampered);
  assert.equal(payload.status, "violated");
  assert.equal(payload.violations, 1);
  assert.equal(payload.files[0].valid, false);
  assert.ok(payload.files[0].errors.length > 0);
  assert.match(payload.recovery, /restore \.sdlc\/traces from version control/u);
  assert.match(payload.recovery, /first back up the history files \(events recorded since your last commit would be lost\)/u);
  assert.doesNotMatch(tampered.stdout, /Rewritten decision wording/u);

  const human = mustFail(["trace", "verify", "--root", project]);
  assert.match(human.stdout, /Outcome: The project history changed unexpectedly\./u);
  assert.match(human.stdout, /\.sdlc\/traces\/project\.jsonl: CHANGED/u);
  const italian = mustFail(["trace", "verify", "--root", project, "--locale", "it"]);
  assert.match(italian.stdout, /Risultato: La cronologia del progetto è cambiata in modo inatteso\./u);

  const append = mustFail([
    "trace", "append", "--root", project, "--type", "decision", "--summary", "after tampering", "--json",
  ]);
  const refusal = json(append);
  assert.equal(refusal.error.code, "TRACE_INTEGRITY_VIOLATION");
  assert.match(refusal.error.message, /agentic-sdlc trace verify/u);
  assert.doesNotMatch(refusal.error.message, /Run the integrity check/u);
});

test("status, doctor, and activity reports surface a tampered history prominently", () => {
  const project = initializedProject("tamper-surfaces");
  appendDecision(project, "Approved boundary A");
  tamperProjectTrace(project, "Approved boundary A", "Approved boundary Z");

  const status = mustRun(["status", "--root", project, "--json"]);
  const statusPayload = json(status);
  assert.equal(statusPayload.history_integrity.status, "violated");
  assert.equal(statusPayload.next_action.kind, "repair_history");
  assert.match(statusPayload.next_action.command, /trace verify$/u);
  const statusHuman = mustRun(["status", "--root", project]);
  assert.match(statusHuman.stdout, /^Outcome: The project history changed unexpectedly\./u);

  const doctor = mustFail(["doctor", "--root", project, "--json"]);
  const integrity = json(doctor).checks.find((check) => check.id === "trace-integrity");
  assert.equal(integrity.status, "failed");
  assert.match(integrity.details, /restore \.sdlc\/traces from version control/u);

  const report = mustRun(["report", "activity", "--root", project, "--since", "1d", "--json"]);
  const reportPayload = json(report);
  assert.equal(reportPayload.integrity.status, "violated");
  const reportHuman = mustRun(["report", "activity", "--root", project, "--since", "1d"]);
  assert.match(reportHuman.stdout, /^Outcome: [^\n]*history changed unexpectedly/iu);
  assert.match(reportHuman.stdout, /WARNING: history changed unexpectedly/u);
});

test("an intact history is consistent for status and verified by doctor and trace verify", () => {
  const project = initializedProject("intact");
  appendDecision(project, "Intact decision");
  const status = json(mustRun(["status", "--root", project, "--json"]));
  // status runs only a quick check, so it never claims a full verification.
  assert.equal(status.history_integrity.status, "consistent");
  assert.equal(status.history_integrity.check, "quick");
  assert.equal(json(mustRun(["trace", "verify", "--root", project, "--json"])).status, "verified");
  assert.notEqual(status.next_action.kind, "repair_history");
  const doctor = json(mustRun(["doctor", "--root", project, "--json"]));
  assert.equal(doctor.checks.find((check) => check.id === "trace-integrity").status, "passed");
  assert.equal(doctor.checks.find((check) => check.id === "trace-size").status, "passed");
});

function addConfiguredPiiPattern(project, pattern) {
  const configPath = path.join(project, ".sdlc", "config.json");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  config.observability.redaction.pii_patterns = [pattern];
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

function confirmConfiguration(project) {
  const preview = json(mustRun(["config", "migrate", "--root", project, "--json"]));
  mustRun(["config", "migrate", "--root", project, "--apply", "--plan-hash", preview.plan.plan_hash, "--json"]);
}

test("activity and query reports apply the configured privacy rules at presentation time", () => {
  const project = initializedProject("report-redaction");
  appendDecision(project, "Escalated case EMP-123456 to support");
  addConfiguredPiiPattern(project, "EMP-[0-9]{6}");
  confirmConfiguration(project);

  const report = mustRun(["report", "activity", "--root", project, "--since", "1d", "--json"]);
  assert.doesNotMatch(report.stdout, /EMP-123456/u);
  assert.match(json(report).items[0].summary, /Escalated case \[REDACTED\] to support/u);

  const human = mustRun(["report", "activity", "--root", project, "--since", "1d"]);
  assert.doesNotMatch(human.stdout, /EMP-123456/u);
  assert.match(human.stdout, /^Outcome: The activity report is ready: 2 recorded events in the chosen period\./u);
  assert.doesNotMatch(human.stdout, /continue only with the next step already agreed/u);

  const out = mustRun(["report", "activity", "--root", project, "--since", "1d", "--out", "activity.md"]);
  assert.match(out.stdout, /Saved to: activity\.md/u);
  const saved = fs.readFileSync(path.join(project, "activity.md"), "utf8");
  assert.doesNotMatch(saved, /EMP-123456/u);
  assert.match(saved, /\[REDACTED\]/u);
  mustRun(["report", "activity", "--root", project, "--since", "1d", "--out", "activity.json"]);
  assert.doesNotMatch(fs.readFileSync(path.join(project, "activity.json"), "utf8"), /EMP-123456/u);

  const query = mustRun([
    "report", "query", "--root", project, "--json",
    "--query-json", JSON.stringify({ intent: "find_records", subjects: ["activity"], time: { since: "1d" } }),
  ]);
  assert.doesNotMatch(query.stdout, /EMP-123456/u);
  assert.equal(json(query).integrity.status, "verified");
});

test("human reports neutralize terminal control characters and count unreadable lines", () => {
  const project = initializedProject("report-terminal");
  const hostile = ["red ", "\u001b[31m", "ALERT", "\u001b[0m", " done", "\r", "OVERWRITE ", "\u0007", "bell"].join("");
  appendDecision(project, hostile);
  const human = mustRun(["report", "activity", "--root", project, "--since", "1d"]);
  assert.doesNotMatch(human.stdout, /\u001b/u);
  assert.doesNotMatch(human.stdout, /\r/u);
  assert.doesNotMatch(human.stdout, /\u0007/u);
  assert.match(human.stdout, /red ALERT done OVERWRITE \\x07bell/u);

  mustRun(["report", "activity", "--root", project, "--since", "1d", "--out", "terminal.md"]);
  const saved = fs.readFileSync(path.join(project, "terminal.md"), "utf8");
  assert.doesNotMatch(saved, /[\u001b\u0007\r]/u);

  fs.appendFileSync(projectTrace(project), "{not json\n");
  const withInvalid = mustRun(["report", "activity", "--root", project, "--since", "1d"]);
  assert.match(withInvalid.stdout, /1 history line could not be read and is not shown in this report\./u);
  const italian = mustRun(["report", "activity", "--root", project, "--since", "1d", "--locale", "it"]);
  assert.match(italian.stdout, /1 riga della cronologia non è stata letta/u);
  assert.equal(json(mustRun(["report", "activity", "--root", project, "--since", "1d", "--json"])).unreadable_lines, 1);
});

test("a future --since explains that --until defaults to now", () => {
  const project = initializedProject("future-since");
  const failure = mustFail(["report", "activity", "--root", project, "--since", "2999-01-01", "--json"]);
  assert.match(json(failure).error.message, /--until defaults to now when it is omitted/u);
});

test("report query with free text says there is no answer and shows a working example", () => {
  const project = initializedProject("query-text");
  const result = mustRun(["report", "query", "--root", project, "--query", "Which decisions were made?"]);
  assert.match(result.stdout, /^Outcome: No answer: this question needs a structured query\./u);
  const example = /Example: agentic-sdlc report query --query-json '([^']+)'/u.exec(result.stdout);
  assert.ok(example, result.stdout);
  mustRun(["report", "query", "--root", project, "--query-json", example[1], "--json"]);
  const italian = mustRun(["report", "query", "--root", project, "--query", "Quali decisioni?", "--locale", "it"]);
  assert.match(italian.stdout, /^Risultato: Nessuna risposta: questa domanda richiede una query strutturata\./u);
});

test("status turns configuration drift into its next action and uses plain labels", () => {
  const project = initializedProject("drift");
  addConfiguredPiiPattern(project, "CASE-[0-9]{4}");
  const status = json(mustRun(["status", "--root", project, "--json"]));
  assert.equal(status.configuration.status, "drifted");
  assert.equal(status.next_action.kind, "migrate_config");
  assert.equal(status.next_action.reason, "configuration_drift");
  assert.match(status.next_action.command, /config migrate$/u);

  const human = mustRun(["status", "--root", project]);
  assert.match(human.stdout, /^Outcome: The project's saved rules were edited after they were last confirmed\./u);
  assert.match(human.stdout, /- Decisions waiting for you: 0/u);
  assert.doesNotMatch(human.stdout, /pending_decisions|internal_refreshes/u);
  const italian = mustRun(["status", "--root", project, "--locale", "it"]);
  assert.match(italian.stdout, /- Decisioni in attesa: 0/u);
  assert.match(italian.stdout, /^Risultato: Le regole salvate del progetto sono state modificate/u);

  const preview = mustRun(["config", "migrate", "--root", project, "--json"]);
  const drift = json(preview).changes_since_confirmation;
  assert.equal(drift.status, "changed");
  assert.equal(drift.change_count, 1);
  assert.equal(drift.changes[0].path, "/observability/redaction/pii_patterns");
  assert.deepEqual(drift.changes[0].after, ["CASE-[0-9]{4}"]);
  const previewHuman = mustRun(["config", "migrate", "--root", project]);
  assert.match(previewHuman.stdout, /^Outcome: The saved rules were edited after they were last confirmed \(1 change\)\./u);
  assert.match(previewHuman.stdout, /replace \/observability\/redaction\/pii_patterns: \[\] -> \["CASE-\[0-9\]\{4\}"\]/u);
});

test("status primary text for a new project avoids internal jargon", () => {
  const project = initializedProject("plain-status");
  const human = mustRun(["status", "--root", project]);
  const [primary] = human.stdout.split("Technical details (optional):");
  assert.doesNotMatch(primary, /decomposition|governed story workflow|task start/iu);
  const italian = mustRun(["status", "--root", project, "--locale", "it"]);
  const [italianPrimary] = italian.stdout.split("Dettagli tecnici (facoltativi):");
  assert.doesNotMatch(italianPrimary, /scomposizione/iu);
});

test("status presents the recorded Git identity under the project privacy rules", () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-sdlc-trace-status-identity-"));
  tempProjects.add(project);
  const email = ["release.owner", "example.test"].join("@");
  for (const args of [["init", "-q"], ["config", "user.email", email], ["config", "user.name", "Release Owner"]]) {
    const result = spawnSync("git", ["-C", project, ...args], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  }
  mustRun(["init", "--root", project, "--project-name", "Identity fixture", "--json"]);
  const stored = fs.readFileSync(path.join(project, ".sdlc", "project.json"), "utf8");
  assert.match(stored, new RegExp(email.replace(".", "\\."), "u"), "stored history is not rewritten");
  const status = mustRun(["status", "--root", project, "--json"]);
  assert.doesNotMatch(status.stdout, new RegExp(email.replace(".", "\\."), "u"));
  assert.match(status.stdout, /\[REDACTED\]/u);
});

test("a damaged project record is refused by trace append and reported by doctor", () => {
  const project = initializedProject("damaged-record");
  const projectPath = path.join(project, ".sdlc", "project.json");
  fs.writeFileSync(projectPath, "{\"project_name\": ");
  const traceBefore = fs.existsSync(projectTrace(project)) ? fs.readFileSync(projectTrace(project), "utf8") : null;

  const append = mustFail(["trace", "append", "--root", project, "--type", "decision", "--summary", "x", "--json"]);
  const payload = json(append);
  assert.equal(payload.error.code, "PROJECT_RECORD_INVALID");
  assert.match(payload.error.message, /The project record \.sdlc\/project\.json is not valid JSON/u);
  assert.doesNotMatch(payload.error.message, new RegExp(project.replaceAll("\\", "\\\\"), "u"));
  const traceAfter = fs.existsSync(projectTrace(project)) ? fs.readFileSync(projectTrace(project), "utf8") : null;
  assert.equal(traceAfter, traceBefore);

  const doctor = mustFail(["doctor", "--root", project, "--json"]);
  const check = json(doctor).checks.find((entry) => entry.id === "project-kb");
  assert.equal(check.status, "failed");
  assert.match(check.details, /not valid JSON/u);

  fs.writeFileSync(projectPath, JSON.stringify({ project_name: 5 }));
  const schemaDoctor = mustFail(["doctor", "--root", project, "--json"]);
  assert.match(json(schemaDoctor).checks.find((entry) => entry.id === "project-kb").details, /does not match the project schema/u);
});

test("an uninitialized folder puts the initialize instruction in the primary next step", () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-sdlc-trace-status-empty-"));
  tempProjects.add(folder);
  const status = mustFail(["status", "--root", folder]);
  assert.match(status.stderr, /Next step: Initialize the project: ask your coding agent to initialize it, or run agentic-sdlc init\./u);
  const italian = mustFail(["status", "--root", folder, "--locale", "it"]);
  assert.match(italian.stderr, /Prossimo passo: Inizializza il progetto/u);
});

test("history size is warned near the read limit and named when exceeded", async () => {
  const { sealTraceEvent } = await import("../../lib/trace-integrity.mjs");
  const project = initializedProject("size-limit");
  const tracesRoot = path.join(project, ".sdlc", "traces");
  const tracePath = path.join(tracesRoot, "project.jsonl");
  const checkpointPath = path.join(tracesRoot, ".integrity", "project.jsonl.checkpoint.json");
  const seal = (index) => sealTraceEvent({
    boundaryRoot: tracesRoot,
    tracePath,
    checkpointPath,
    event: {
      id: `TR-SIZE-${index}`,
      type: "decision",
      summary: `filler ${index} ${"x".repeat(240_000)}`,
      created_at: new Date().toISOString(),
      action: "trace.append",
      actor: { type: "human", id: "fixture" },
      git: {},
      run: {},
      story_id: null,
    },
  });
  let index = 0;
  while (!fs.existsSync(tracePath) || fs.statSync(tracePath).size < 7 * 1024 * 1024) seal(index++);

  const status = mustRun(["status", "--root", project, "--json"]);
  assert.equal(json(status).history_integrity.files[0].size_state, "near_limit");
  const statusHuman = mustRun(["status", "--root", project]);
  assert.match(statusHuman.stdout, /\.sdlc\/traces\/project\.jsonl is [0-9.]+ MiB; the history read limit is 8\.0 MiB/u);
  const doctor = json(mustRun(["doctor", "--root", project, "--json"]));
  const size = doctor.checks.find((check) => check.id === "trace-size");
  assert.equal(size.status, "passed");
  assert.equal(size.warning, true);

  while (fs.statSync(tracePath).size <= 8 * 1024 * 1024) seal(index++);
  const over = mustFail(["status", "--root", project, "--json"]);
  const error = json(over).error;
  assert.equal(error.code, "TRACE_HISTORY_TOO_LARGE");
  assert.match(error.message, /\.sdlc\/traces\/project\.jsonl exceeds the 8\.0 MiB per-file history read limit/u);
  const report = mustFail(["report", "activity", "--root", project, "--json"]);
  assert.equal(json(report).error.code, "TRACE_HISTORY_TOO_LARGE");
  const verify = json(mustRun(["trace", "verify", "--root", project, "--json"]));
  assert.equal(verify.files[0].size_state, "over_limit");
  assert.equal(json(mustFail(["doctor", "--root", project, "--json"])).checks.find((check) => check.id === "trace-size").status, "failed");
});

test("trace append refuses evidence outside the project and flags missing evidence", () => {
  const project = initializedProject("evidence-paths");
  const outside = path.join(os.tmpdir(), "agentic-sdlc-outside-evidence.txt");
  for (const evidence of [outside, "../../outside.txt", "docs/../../outside.txt"]) {
    const failure = mustFail([
      "trace", "append", "--root", project, "--type", "decision", "--summary", "outside", "--evidence", evidence, "--json",
    ]);
    assert.match(json(failure).error.message, /Evidence path must name a file inside this project/u, evidence);
  }
  assert.equal(fs.existsSync(projectTrace(project)), false, "refused evidence must not append an event");

  const missing = json(mustRun([
    "trace", "append", "--root", project, "--type", "decision", "--summary", "missing",
    "--evidence", "docs/not-yet-written.md", "--json",
  ]));
  assert.deepEqual(missing.evidence_unverified, ["docs/not-yet-written.md"]);
  assert.equal(missing.trace_path, ".sdlc/traces/project.jsonl");
  const human = mustRun([
    "trace", "append", "--root", project, "--type", "decision", "--summary", "missing again",
    "--evidence", "docs/not-yet-written.md",
  ]);
  assert.match(human.stdout, /Evidence not verified: docs\/not-yet-written\.md does not exist/u);

  fs.writeFileSync(path.join(project, "notes.txt"), "evidence\n");
  const present = json(mustRun([
    "trace", "append", "--root", project, "--type", "decision", "--summary", "present",
    "--evidence", path.join(project, "notes.txt"), "--json",
  ]));
  assert.deepEqual(present.event.evidence, ["notes.txt"]);
  assert.deepEqual(present.evidence_unverified, []);
});

test("status and approval requests list a proposed requirement waiting for approval", () => {
  const project = initializedProject("proposed-requirement");
  mustRun([
    "requirement", "propose", "--root", project,
    "--id", "REQ-BOOKING-001",
    "--title", "Reliable booking confirmation",
    "--summary", "Confirm a booking once",
    "--acceptance", "One confirmation reference",
    "--autonomy-ceiling", "checkpointed",
    "--write-path", "src",
    "--json",
  ]);
  const status = json(mustRun(["status", "--root", project, "--json"]));
  assert.equal(status.summary.pending_decisions, 1);
  assert.equal(status.next_action.kind, "review_decision");

  const requests = json(mustRun(["approval", "requests", "--root", project, "--json", "--full"]));
  assert.equal(requests.status, "needs_user_input");
  const request = requests.requests.find((item) => item.type === "requirement_approval");
  assert.ok(request, JSON.stringify(requests));
  assert.equal(request.subject_id, "REQ-BOOKING-001");
  assert.match(request.suggested_command, /^agentic-sdlc requirement approve --id REQ-BOOKING-001 /u);
  const human = mustRun(["approval", "requests", "--root", project]);
  assert.match(human.stdout, /1\. Proposed requirement/u);
  const italian = mustRun(["approval", "requests", "--root", project, "--locale", "it"]);
  assert.match(italian.stdout, /1\. Requisito proposto/u);
});

test("init ends with a concrete first step instead of the generic result text", () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-sdlc-trace-status-init-"));
  tempProjects.add(folder);
  const result = mustRun(["init", "--root", folder]);
  assert.match(result.stdout, /^Outcome: The project is ready for guided delivery\./u);
  assert.match(result.stdout, /Next step: Propose your first requirement/u);
  assert.doesNotMatch(result.stdout, /The requested result is ready/u);
});

function sealDirectly(project, events, traceName = "project.jsonl") {
  const tracesRoot = path.join(project, ".sdlc", "traces");
  for (const event of events) {
    sealTraceEvent({
      boundaryRoot: tracesRoot,
      tracePath: path.join(tracesRoot, traceName),
      checkpointPath: path.join(tracesRoot, ".integrity", `${traceName}.checkpoint.json`),
      event,
    });
  }
}

function fixtureEvent(index, summary = `Decision ${index}`) {
  return {
    id: `TR-FIXTURE-${index}`,
    type: "decision",
    summary,
    created_at: new Date().toISOString(),
    action: "decision",
    actor: { type: "human", id: "fixture" },
    evidence: [],
    related: [],
    git: {},
    run: {},
    story_id: null,
  };
}

test("evidence snapshots below .sdlc/traces are not verified as sealed histories", () => {
  const project = initializedProject("evidence-snapshot");
  fs.writeFileSync(path.join(project, "results.jsonl"), "{\"case\":1}\n\n{\"case\":2}");
  const append = json(mustRun([
    "trace", "append", "--root", project, "--type", "test", "--outcome", "passed",
    "--summary", "Results recorded", "--evidence", "results.jsonl", "--json",
  ]));
  assert.match(append.event.evidence[0], /^\.sdlc\/traces\/evidence\//u);

  const verify = json(mustRun(["trace", "verify", "--root", project, "--json"]));
  assert.equal(verify.status, "verified");
  assert.deepEqual(verify.files.map((file) => file.path), [".sdlc/traces/project.jsonl"]);
  const status = json(mustRun(["status", "--root", project, "--json"]));
  assert.notEqual(status.next_action.kind, "repair_history");
  const doctor = json(mustRun(["doctor", "--root", project, "--json"]));
  assert.equal(doctor.checks.find((check) => check.id === "trace-integrity").status, "passed");
  const gate = JSON.parse(runCli(["gate", "check", "--root", project, "--json"]).stdout);
  assert.equal([...gate.checked, ...gate.errors].some((line) => line.includes("traces/evidence/")), false);
});

test("an interrupted write is reported as recoverable, never as tampering", () => {
  const project = initializedProject("interrupted");
  appendDecision(project, "Committed decision");
  const tracesRoot = path.join(project, ".sdlc", "traces");
  const checkpointPath = path.join(tracesRoot, ".integrity", "project.jsonl.checkpoint.json");
  const checkpointBefore = fs.readFileSync(checkpointPath);
  sealDirectly(project, [fixtureEvent(1, "Written before the interruption")]);
  // The event reached the trace, but the checkpoint update did not.
  fs.writeFileSync(checkpointPath, checkpointBefore);

  const verify = mustRun(["trace", "verify", "--root", project, "--json"]);
  const payload = json(verify);
  assert.equal(payload.status, "recovery_needed");
  assert.equal(payload.files[0].state, "recoverable");
  assert.doesNotMatch(payload.recovery, /checkout/u);
  assert.match(payload.recovery, /completes the repair automatically/u);
  const human = mustRun(["trace", "verify", "--root", project]);
  assert.match(human.stdout, /Do not restore the history from version control/u);

  const status = json(mustRun(["status", "--root", project, "--json"]));
  assert.equal(status.history_integrity.status, "recovery_needed");
  assert.notEqual(status.next_action.kind, "repair_history");
  const doctor = json(mustRun(["doctor", "--root", project, "--json"]));
  const check = doctor.checks.find((entry) => entry.id === "trace-integrity");
  assert.equal(check.status, "passed");
  assert.equal(check.warning, true);

  appendDecision(project, "Recorded after the interruption");
  assert.equal(json(mustRun(["trace", "verify", "--root", project, "--json"])).status, "verified");
});

test("a history file above the verification limit is unverifiable, not tampered", async () => {
  const { buildContext } = await import("../../lib/engine/common.mjs");
  const { inspectTraceHistory } = await import("../../lib/engine/story.mjs");
  const project = initializedProject("unverifiable");
  appendDecision(project, "A decision large enough for a tiny limit");
  const inspection = inspectTraceHistory(buildContext({ root: project }), { maxVerificationTraceBytes: 64 });
  assert.equal(inspection.status, "unverifiable");
  assert.equal(inspection.violations, 0);
  assert.equal(inspection.files[0].state, "unverifiable");
  assert.deepEqual(inspection.files[0].errors, [{ code: "trace_too_large", scope: "trace" }]);
});

test("large reports and status payloads are redacted item by item instead of collapsing", () => {
  const project = initializedProject("large-presentation");
  const email = ["owner", "example.test"].join("@");
  sealDirectly(project, Array.from({ length: 700 }, (_, index) => fixtureEvent(index, `Decision ${index} by ${email}`)));
  const report = json(mustRun(["report", "activity", "--root", project, "--since", "1d", "--json"]));
  assert.equal(report.items.length, 700);
  assert.equal(report.items[699].summary, "Decision 699 by [REDACTED]");
  assert.doesNotMatch(JSON.stringify(report), new RegExp(email.replace(".", "\\."), "u"));

  mustRun([
    "requirement", "propose", "--root", project,
    "--id", "REQ-BULK-SOURCE",
    "--title", "Bulk source",
    "--summary", "Template for many proposals",
    "--acceptance", "One check",
    "--autonomy-ceiling", "checkpointed",
    "--write-path", "src",
    "--json",
  ]);
  const requirementsRoot = path.join(project, ".sdlc", "requirements");
  const source = JSON.parse(fs.readFileSync(path.join(requirementsRoot, "REQ-BULK-SOURCE.json"), "utf8"));
  for (let index = 0; index < 400; index += 1) {
    const id = `REQ-BULK-${String(index).padStart(4, "0")}`;
    fs.writeFileSync(path.join(requirementsRoot, `${id}.json`), `${JSON.stringify({ ...source, id, logical_id: id })}\n`);
  }
  const status = json(mustRun(["status", "--root", project, "--json", "--full"]));
  assert.equal(status.project.project_name, "Trace status fixture");
  assert.equal(status.summary.pending_decisions, 401);
  assert.equal(status.pending_decision_items.length, 401);
  const human = mustRun(["status", "--root", project, "--full"]);
  assert.match(human.stdout, /- Project: Trace status fixture \(/u);
  assert.doesNotMatch(human.stdout, /undefined|LIMIT_EXCEEDED/u);
});

test("evidence URLs are kept as references and dotted names inside the project are accepted", () => {
  const project = initializedProject("evidence-urls");
  fs.mkdirSync(path.join(project, "..reports"));
  fs.writeFileSync(path.join(project, "..reports", "r.txt"), "report\n");
  const appended = json(mustRun([
    "trace", "append", "--root", project, "--type", "decision", "--summary", "references",
    "--evidence", "https://ci.example.test/runs/42",
    "--evidence", "..reports/r.txt",
    "--json",
  ]));
  assert.deepEqual(appended.event.evidence, ["https://ci.example.test/runs/42", "..reports/r.txt"]);
  assert.deepEqual(appended.evidence_unverified, []);

  for (const reference of ["file:///etc/passwd", "ftp://files.example.test/report.txt", "data:text/plain,hello"]) {
    const refused = mustFail([
      "trace", "append", "--root", project, "--type", "decision", "--summary", "other scheme",
      "--evidence", reference, "--json",
    ]);
    assert.match(json(refused).error.message, /inside this project or an http\(s\) URL/u, reference);
  }
});

test("status reports a sealed history whose checkpoint was deleted as changed", () => {
  const project = initializedProject("checkpoint-deleted");
  appendDecision(project, "Original wording");
  tamperProjectTrace(project, "Original wording", "Changed wording!");
  fs.rmSync(path.join(project, ".sdlc", "traces", ".integrity"), { recursive: true, force: true });

  const status = json(mustRun(["status", "--root", project, "--json"]));
  assert.equal(status.history_integrity.status, "violated");
  assert.equal(status.next_action.kind, "repair_history");
  assert.deepEqual(status.history_integrity.files[0].errors, [{ code: "checkpoint_missing", scope: "checkpoint" }]);
  const verify = json(mustFail(["trace", "verify", "--root", project, "--json"]));
  assert.equal(verify.status, "violated");
});

test("status keeps an unsealed legacy history without a checkpoint consistent", () => {
  const project = initializedProject("legacy-unsealed");
  fs.writeFileSync(projectTrace(project), `${JSON.stringify(fixtureEvent(1, "Legacy event"))}\n`);
  const status = json(mustRun(["status", "--root", project, "--json"]));
  assert.equal(status.history_integrity.status, "consistent");
});

test("a project with many custom patterns can still record history", () => {
  const project = initializedProject("many-patterns");
  const configPath = path.join(project, ".sdlc", "config.json");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  config.observability.redaction.pii_patterns = Array.from(
    { length: 56 },
    (_, index) => `CASE${String(index).padStart(2, "0")}-[0-9]{4}`,
  );
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  confirmConfiguration(project);
  fs.writeFileSync(path.join(project, "result.txt"), "case CASE07-1234 passed\n");
  const appended = json(mustRun([
    "trace", "append", "--root", project, "--type", "test", "--outcome", "passed",
    "--summary", "Recorded with CASE03-9999", "--evidence", "result.txt", "--json",
  ]));
  assert.equal(appended.event.summary, "Recorded with [REDACTED]");
  const snapshot = fs.readFileSync(path.join(project, ...appended.event.evidence[0].split("/")), "utf8");
  assert.doesNotMatch(snapshot, /CASE07-1234/u);
});

test("historical operational_v2 evidence written before detector additions can still be bound", async () => {
  const { createOperationalBaselineRedactionPolicy, createOperationalRedactionPolicy, redactText } = await import("../../lib/observability/redaction.mjs");
  const project = initializedProject("baseline-binding");
  const raw = ["deploy --password ", "hunter", "22secret ok\n"].join("");
  assert.notEqual(
    redactText(raw, createOperationalBaselineRedactionPolicy()),
    redactText(raw, createOperationalRedactionPolicy()),
    "fixture must differ between the original and the current detector set",
  );
  fs.writeFileSync(path.join(project, "deploy.txt"), raw);
  const append = json(mustRun([
    "trace", "append", "--root", project, "--type", "test", "--outcome", "passed",
    "--summary", "Historical evidence", "--evidence", "deploy.txt", "--json",
  ]));
  const event = JSON.parse(JSON.stringify(append.event));
  const ref = event.evidence_refs[0];
  // Recreate a historical v1 reference: the snapshot holds the original
  // bytes and the fingerprint was computed with the original detector set.
  fs.writeFileSync(path.join(project, ...ref.path.split("/")), raw);
  const historical = Buffer.from(redactText(raw, createOperationalBaselineRedactionPolicy()), "utf8");
  ref.representation = "redacted_utf8_v1";
  delete ref.policy_source_ref;
  ref.size_bytes = historical.length;
  ref.sha256 = crypto.createHash("sha256").update(historical).digest("hex");
  delete event._trace_integrity;
  const tracesRoot = path.join(project, ".sdlc", "traces");
  fs.rmSync(path.join(tracesRoot, "project.jsonl"));
  fs.rmSync(path.join(tracesRoot, ".integrity"), { recursive: true, force: true });
  sealDirectly(project, [event]);

  const binding = json(mustRun([
    "trace", "evidence", "bind", "--root", project,
    "--target-event", event.id,
    "--redaction-policy", "operational_v2",
    "--json",
  ]));
  assert.equal(binding.status, "bound");
  assert.equal(binding.binding_count, 1);
});
