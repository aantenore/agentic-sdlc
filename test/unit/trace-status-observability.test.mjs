import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

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

function runCli(args, options = {}) {
  const env = { ...process.env };
  for (const key of [
    "CI",
    "GITHUB_ACTIONS",
    "GITHUB_ACTOR",
    "CODEX_AGENT_NAME",
    "CODEX_USER_ID",
    "CLAUDECODE",
    "AGENTIC_SDLC_AGENT_HOST",
    "NODE_OPTIONS",
  ]) {
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

test("an intact history is reported as verified by status and doctor", () => {
  const project = initializedProject("intact");
  appendDecision(project, "Intact decision");
  const status = json(mustRun(["status", "--root", project, "--json"]));
  assert.equal(status.history_integrity.status, "verified");
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
