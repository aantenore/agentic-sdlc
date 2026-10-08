import test from "node:test";
import assert from "node:assert/strict";

import {
  CHECK_KINDS,
  CHECK_STATUSES,
  PULL_REQUEST_CHECKS_SCHEMA,
  buildPullRequestChecks,
  classifyEvidencePath,
  displayCommand,
  renderPullRequestChecksMarkdown,
} from "../../lib/delivery/pull-request-checks.mjs";

const HEAD = "0123456789abcdef0123456789abcdef01234567";
const OLD_HEAD = "fedcba9876543210fedcba9876543210fedcba98";

function delivery(overrides = {}) {
  return {
    profile_id: "AUT-PR-1",
    delivery_id: "PR-1",
    story_id: "ST-1",
    repository: "github.com/example/project",
    base_branch: "main",
    head_branch: "feature/one",
    ...overrides,
  };
}

function testRun(overrides = {}) {
  return {
    id: "ST-1-test-run-a",
    path: ".sdlc/tests/ST-1-test-run-a.json",
    argv: ["npm", "test"],
    outcome: "passed",
    exit_code: 0,
    totals: { passed: 12, failed: 0, skipped: 1 },
    finished_at: "2026-05-01T10:00:00.000Z",
    evidence: [".sdlc/tests/ST-1-run.log"],
    ...overrides,
  };
}

function review(overrides = {}) {
  return {
    id: "ST-1-code-review-a",
    path: ".sdlc/reviews/ST-1-code-review-a.json",
    verdict: "approved",
    reviewer_id: "luca",
    reviewed_head_sha: HEAD,
    reviewed_at: "2026-05-01T11:00:00.000Z",
    independent: true,
    finding_count: 0,
    blocking_count: 0,
    ...overrides,
  };
}

function completeFacts() {
  return {
    delivery: delivery(),
    head_sha: HEAD,
    tests: [testRun()],
    smoke_tests: [testRun({
      id: "ST-1-smoke",
      path: ".sdlc/tests/ST-1-smoke.json",
      argv: ["npm", "run", "smoke"],
      totals: { passed: 1, failed: 0, skipped: 0 },
      evidence: [],
    })],
    secret_scans: [{
      id: "ST-1-secret-scan-a",
      path: ".sdlc/security/ST-1-secret-scan-a.json",
      outcome: "clean",
      file_count: 4,
      finding_count: 0,
      head_sha: HEAD,
      current: true,
      finished_at: "2026-05-01T10:30:00.000Z",
    }],
    code_review: { required: true, reviews: [review()] },
    gates: {
      strict: { path: ".sdlc/gates/ST-1-strict.json", checked_at: "2026-05-01T12:00:00.000Z" },
      final: null,
    },
    standing_approval: {
      id: "SA-DEPS",
      status: "active",
      used: true,
      slot: 2,
      max_deliveries: 5,
      evidence: [".sdlc/autonomy/standing/SA-DEPS/approval.json"],
    },
    budget: {
      state: "recorded",
      blocked: false,
      bound: true,
      reason_codes: [],
      evidence: [".sdlc/autonomy/decisions/AUT-DEC-1.json"],
    },
    ignored_records: 0,
  };
}

function rowFor(model, kind) {
  return model.checks.filter((check) => check.kind === kind);
}

test("every check kind and status the model can emit is declared", () => {
  const model = buildPullRequestChecks(completeFacts());
  assert.equal(model.schema_version, PULL_REQUEST_CHECKS_SCHEMA);
  assert.deepEqual([...new Set(model.checks.map((check) => check.kind))].sort(), [...CHECK_KINDS].sort());
  for (const check of model.checks) assert.ok(CHECK_STATUSES.includes(check.status), check.status);
  assert.deepEqual(model.checks.map((check) => check.kind), [
    "tests",
    "smoke_tests",
    "secret_scan",
    "code_review",
    "strict_gate",
    "final_gate",
    "standing_approval",
    "budget_decision",
  ]);
});

test("a delivery with no records reports every check as not run, never as passed", () => {
  const model = buildPullRequestChecks({ delivery: delivery() });
  assert.equal(model.overall, "not_run");
  assert.deepEqual(model.summary, { pass: 0, fail: 0, not_run: 7 });
  assert.ok(model.checks.every((check) => check.status === "not_run"));
  assert.equal(rowFor(model, "standing_approval").length, 0, "no standing approval row when none is used");
  const markdown = renderPullRequestChecksMarkdown(model);
  assert.match(markdown, /\| Tests \| \[NOT RUN\] \| No test run is recorded for this delivery\. \| none \|/u);
  assert.match(markdown, /No smoke test run is recorded/u);
  assert.match(markdown, /not checked out here/u);
});

test("recorded checks keep their status, and a newer run supersedes an older pass of the same command", () => {
  const facts = completeFacts();
  facts.tests = [
    testRun({ id: "run-1", finished_at: "2026-05-01T09:00:00.000Z" }),
    testRun({
      id: "run-2",
      finished_at: "2026-05-01T10:00:00.000Z",
      outcome: "failed",
      exit_code: 1,
      totals: { passed: 10, failed: 2, skipped: 0 },
      path: ".sdlc/tests/run-2.json",
      evidence: [".sdlc/tests/run-2.log"],
    }),
    testRun({ id: "lint", argv: ["npm", "run", "lint"], path: ".sdlc/tests/lint.json", evidence: [] }),
  ];
  const model = buildPullRequestChecks(facts);
  const tests = rowFor(model, "tests");
  assert.deepEqual(tests.map((check) => [check.subject, check.status]), [
    ["npm run lint", "pass"],
    ["npm test", "fail"],
  ]);
  assert.equal(tests[1].facts.earlier_runs, 1);
  assert.deepEqual(tests[1].evidence, [".sdlc/tests/run-2.json", ".sdlc/tests/run-2.log"]);
  assert.equal(model.overall, "fail");
});

test("blocked and skipped test runs are not a pass", () => {
  for (const outcome of ["blocked", "skipped"]) {
    const model = buildPullRequestChecks({
      delivery: delivery(),
      tests: [testRun({ outcome, exit_code: 2, totals: { passed: 0, failed: 0, skipped: 3 } })],
    });
    assert.equal(rowFor(model, "tests")[0].status, "not_run", outcome);
  }
});

test("the secret scan row follows the latest scan that still covers the current state", () => {
  const scan = (overrides) => ({
    id: "scan",
    path: ".sdlc/security/scan.json",
    outcome: "clean",
    file_count: 3,
    finding_count: 0,
    head_sha: HEAD,
    current: true,
    finished_at: "2026-05-01T10:00:00.000Z",
    ...overrides,
  });
  const status = (scans) => rowFor(buildPullRequestChecks({ delivery: delivery(), head_sha: HEAD, secret_scans: scans }), "secret_scan")[0];

  assert.equal(status([scan()]).status, "pass");
  const findings = status([scan({ outcome: "findings", finding_count: 2 })]);
  assert.equal(findings.status, "fail");
  assert.equal(findings.facts.finding_count, 2);
  const stale = status([scan({ current: false, head_sha: OLD_HEAD })]);
  assert.equal(stale.status, "not_run");
  assert.equal(stale.facts.state, "stale");
  // An older clean scan of a stale state never hides a newer scan that found something.
  assert.equal(status([
    scan({ id: "old", current: false, finished_at: "2026-05-01T08:00:00.000Z" }),
    scan({ id: "new", outcome: "findings", finding_count: 1, finished_at: "2026-05-01T09:00:00.000Z" }),
  ]).status, "fail");
});

test("the code review row mirrors the independent-reviewer merge gate", () => {
  const status = (reviews, headSha = HEAD) => rowFor(
    buildPullRequestChecks({ delivery: delivery(), head_sha: headSha, code_review: { required: true, reviews } }),
    "code_review",
  )[0];

  assert.equal(status([]).facts.state, "none");
  assert.equal(status([review()]).status, "pass");
  assert.equal(status([review({ independent: false })]).facts.state, "author_only");
  assert.equal(status([review({ independent: false })]).status, "not_run");
  const stale = status([review({ reviewed_head_sha: OLD_HEAD })]);
  assert.equal(stale.facts.state, "stale");
  assert.equal(stale.status, "not_run");
  // A later changes_requested from an independent reviewer withdraws an earlier approval of the same head.
  const withdrawn = status([
    review({ id: "a", reviewed_at: "2026-05-01T11:00:00.000Z" }),
    review({ id: "b", reviewed_at: "2026-05-01T12:00:00.000Z", verdict: "changes_requested", blocking_count: 1 }),
  ]);
  assert.equal(withdrawn.status, "fail");
  // An author's approval does not count next to an independent request for changes.
  assert.equal(status([
    review({ id: "a", independent: false, reviewed_at: "2026-05-01T13:00:00.000Z" }),
    review({ id: "b", verdict: "changes_requested", reviewed_at: "2026-05-01T12:00:00.000Z" }),
  ]).status, "fail");
});

test("gate, standing approval, and budget rows report only what was recorded", () => {
  const model = buildPullRequestChecks(completeFacts());
  assert.deepEqual(rowFor(model, "strict_gate")[0].evidence, [".sdlc/gates/ST-1-strict.json"]);
  assert.equal(rowFor(model, "strict_gate")[0].status, "pass");
  assert.equal(rowFor(model, "final_gate")[0].status, "not_run");
  assert.equal(rowFor(model, "standing_approval")[0].status, "pass");
  assert.equal(rowFor(model, "budget_decision")[0].status, "pass");

  const revoked = buildPullRequestChecks({
    delivery: delivery(),
    standing_approval: { id: "SA-DEPS", status: "revoked", used: true, slot: 1, max_deliveries: 3, evidence: [] },
    budget: { state: "recorded", blocked: true, bound: true, reason_codes: ["budget.start_not_allowed"], evidence: [] },
  });
  assert.equal(rowFor(revoked, "standing_approval")[0].status, "fail");
  assert.equal(rowFor(revoked, "budget_decision")[0].status, "fail");

  const unused = buildPullRequestChecks({
    delivery: delivery(),
    standing_approval: { id: "SA-DEPS", status: "active", used: false, evidence: [] },
    budget: { state: "recorded", blocked: false, bound: false, reason_codes: [], evidence: [] },
  });
  assert.equal(rowFor(unused, "standing_approval")[0].status, "not_run");
  assert.equal(rowFor(unused, "budget_decision")[0].status, "not_run");
  assert.equal(rowFor(buildPullRequestChecks({ delivery: delivery(), budget: { state: "not_started" } }), "budget_decision")[0].status, "not_run");
});

test("the Markdown table is deterministic and independent of the order the records arrive in", () => {
  const facts = completeFacts();
  facts.tests = [
    testRun({ id: "b", argv: ["npm", "run", "lint"], path: ".sdlc/tests/b.json" }),
    testRun({ id: "a" }),
  ];
  const reversed = { ...facts, tests: facts.tests.slice().reverse() };
  const first = renderPullRequestChecksMarkdown(buildPullRequestChecks(facts));
  assert.equal(renderPullRequestChecksMarkdown(buildPullRequestChecks(facts)), first);
  assert.equal(renderPullRequestChecksMarkdown(buildPullRequestChecks(reversed)), first);
  assert.ok(first.endsWith("\n") && !first.endsWith("\n\n"));
});

test("a complete delivery renders the documented table", () => {
  const markdown = renderPullRequestChecksMarkdown(buildPullRequestChecks(completeFacts()));
  assert.equal(markdown, [
    "## Delivery checks",
    "",
    "Delivery `PR-1` (profile `AUT-PR-1`, story `ST-1`): 7 pass, 0 fail, 1 not run.",
    "",
    "| Check | Status | Details | Evidence |",
    "| --- | --- | --- | --- |",
    "| Tests | [PASS] | `npm test`: passed (exit 0; 12 passed, 0 failed, 1 skipped), recorded 2026-05-01T10:00:00.000Z | [`.sdlc/tests/ST-1-run.log`](.sdlc/tests/ST-1-run.log)<br>[`.sdlc/tests/ST-1-test-run-a.json`](.sdlc/tests/ST-1-test-run-a.json) |",
    "| Smoke tests | [PASS] | `npm run smoke`: passed (exit 0; 1 passed, 0 failed, 0 skipped), recorded 2026-05-01T10:00:00.000Z | [`.sdlc/tests/ST-1-smoke.json`](.sdlc/tests/ST-1-smoke.json) |",
    "| Secret scan | [PASS] | Clean: 4 files scanned at head `0123456789ab` | [`.sdlc/security/ST-1-secret-scan-a.json`](.sdlc/security/ST-1-secret-scan-a.json) |",
    "| Code review gate | [PASS] | Approved by `luca` at head `0123456789ab`. Merge gate: required. | [`.sdlc/reviews/ST-1-code-review-a.json`](.sdlc/reviews/ST-1-code-review-a.json) |",
    "| Strict gate | [PASS] | Strict story gate passed; receipt sealed 2026-05-01T12:00:00.000Z | [`.sdlc/gates/ST-1-strict.json`](.sdlc/gates/ST-1-strict.json) |",
    "| Lifecycle-complete gate | [NOT RUN] | No passing lifecycle-complete gate receipt is recorded for story `ST-1`. | none |",
    "| Standing approval | [PASS] | `SA-DEPS`: delivery slot 2 of 5; the standing approval is now active | [`.sdlc/autonomy/standing/SA-DEPS/approval.json`](.sdlc/autonomy/standing/SA-DEPS/approval.json) |",
    "| Budget decision | [PASS] | An execution budget is bound and allowed the start; delivery usage is not metered, so the level stays capped at checkpointed. | [`.sdlc/autonomy/decisions/AUT-DEC-1.json`](.sdlc/autonomy/decisions/AUT-DEC-1.json) |",
    "",
    "_Generated by agentic-sdlc from the records under `.sdlc/`. Each row reports what was recorded; nothing was re-run and this table approves nothing._",
    "",
  ].join("\n"));
});

test("table cells survive pipes, backticks, and line breaks in recorded commands", () => {
  const model = buildPullRequestChecks({
    delivery: delivery(),
    head_sha: HEAD,
    tests: [testRun({ argv: ["node", "-e", "a|b`c`\nd"], evidence: [] })],
  });
  const markdown = renderPullRequestChecksMarkdown(model);
  const testsRow = markdown.split("\n").find((line) => line.startsWith("| Tests |"));
  // Four columns means five unescaped pipes, whatever the command contained.
  assert.equal(testsRow.match(/(?<!\\)\|/gu).length, 5, testsRow);
  assert.ok(!testsRow.includes("\n"));
  assert.match(testsRow, /a\\\|b/u);
});

test("evidence is linked only when it is a plain project-relative path", () => {
  assert.equal(classifyEvidencePath(".sdlc/tests/run.json"), "link");
  assert.equal(classifyEvidencePath("src/a b.txt"), "text");
  assert.equal(classifyEvidencePath("src/(x).txt"), "text");
  for (const unsafe of [
    "/etc/passwd",
    "../outside.json",
    "a/../b.json",
    "./a.json",
    "a//b.json",
    "C:/Users/x/a.json",
    "C:\\Users\\x\\a.json",
    "https://example.com/a.json",
    "javascript:alert(1)",
    "file:///tmp/a.json",
    "a\\b.json",
    "a\nb.json",
    "",
  ]) {
    assert.equal(classifyEvidencePath(unsafe), "drop", JSON.stringify(unsafe));
  }

  const facts = completeFacts();
  facts.tests = [testRun({
    path: ".sdlc/tests/run.json",
    evidence: ["/home/dev/secret/run.log", "../escape.log", "https://example.com/x", "reports/final report.txt"],
  })];
  const model = buildPullRequestChecks(facts);
  assert.deepEqual(rowFor(model, "tests")[0].evidence, [".sdlc/tests/run.json", "reports/final report.txt"]);
  const markdown = renderPullRequestChecksMarkdown(model);
  assert.ok(!markdown.includes("/home/dev"));
  assert.ok(!markdown.includes("escape.log"));
  assert.ok(!markdown.includes("example.com"));
  assert.match(markdown, /\[`\.sdlc\/tests\/run\.json`\]\(\.sdlc\/tests\/run\.json\)/u);
  assert.match(markdown, /<br>`reports\/final report\.txt`/u, "a path a link cannot carry is shown as text, not as a link");
  const links = [...markdown.matchAll(/\]\(([^)]*)\)/gu)].map((match) => match[1]);
  assert.ok(links.length > 0);
  for (const target of links) assert.equal(classifyEvidencePath(target), "link", target);
});

test("the Italian table has the same shape as the English one", () => {
  const model = buildPullRequestChecks(completeFacts());
  const english = renderPullRequestChecksMarkdown(model, { locale: "en" }).split("\n");
  const italian = renderPullRequestChecksMarkdown(model, { locale: "it" }).split("\n");
  assert.equal(italian.length, english.length);
  assert.equal(italian[0], "## Controlli della consegna");
  assert.match(italian[2], /7 superati, 0 falliti, 1 non eseguiti/u);
  const cells = (line) => line.split(/(?<!\\)\|/u).length;
  for (let index = 0; index < english.length; index += 1) {
    assert.equal(cells(italian[index]), cells(english[index]), `line ${index + 1}`);
  }
  assert.match(italian.join("\n"), /\[SUPERATO\]/u);
  assert.match(italian.join("\n"), /\[NON ESEGUITO\]/u);
  assert.match(renderPullRequestChecksMarkdown(buildPullRequestChecks({ delivery: delivery(), ignored_records: 2 }), { locale: "it" }), /2 file registrati non hanno superato la validazione e sono stati esclusi\./u);
  assert.match(renderPullRequestChecksMarkdown(buildPullRequestChecks({ delivery: delivery(), ignored_records: 1 }), { locale: "it" }), /1 file registrato non ha superato la validazione ed è stato escluso\./u);
  // An unsupported locale falls back to English rather than printing blanks.
  assert.equal(renderPullRequestChecksMarkdown(model, { locale: "fr" }), renderPullRequestChecksMarkdown(model, { locale: "en" }));
});

test("the model never carries a reviewer email or an unsafe evidence path", () => {
  const facts = completeFacts();
  facts.code_review.reviews = [review({ reviewer_email: "luca@example.invalid", path: "/abs/review.json" })];
  const json = JSON.stringify(buildPullRequestChecks(facts));
  assert.ok(!json.includes("luca@example.invalid"));
  assert.ok(!json.includes("/abs/review.json"));
});

test("commands are shown as recorded and quoted only where a shell would need it", () => {
  assert.equal(displayCommand(["npm", "run", "test:unit"]), "npm run test:unit");
  assert.equal(displayCommand(["node", "-e", "console.log('x y')"]), "node -e 'console.log('\\''x y'\\'')'");
  assert.equal(displayCommand(["echo", ""]), "echo ''");
  // The model keeps the whole command; only the rendered table shortens it.
  assert.equal(displayCommand(["x".repeat(500)]).length, 500);
  const long = buildPullRequestChecks({ delivery: delivery(), tests: [testRun({ argv: ["x".repeat(500)] })] });
  assert.equal(rowFor(long, "tests")[0].subject.length, 500);
  const row = renderPullRequestChecksMarkdown(long).split("\n").find((line) => line.startsWith("| Tests |"));
  assert.match(row, /`x{199}…`/u);
  assert.ok(!row.includes("x".repeat(200)));
});
