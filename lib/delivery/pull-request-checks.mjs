/**
 * The checks table of a pull-request delivery.
 *
 * Everything here is pure. The caller reads the project's records and hands
 * over plain facts; this module decides each row's status and renders the
 * result. A row only ever reports what was recorded: nothing is re-run, and a
 * missing record is "not run" rather than an inferred pass.
 *
 * The model is language neutral. Human wording exists only in the Markdown
 * renderer, in English and Italian, so a person can paste the table into a
 * pull-request description while a pipeline reads the same facts as JSON.
 */

export const PULL_REQUEST_CHECKS_SCHEMA = "pull-request-checks:v1";
export const CHECK_STATUSES = Object.freeze(["pass", "fail", "not_run"]);
export const CHECK_KINDS = Object.freeze([
  "tests",
  "smoke_tests",
  "secret_scan",
  "code_review",
  "strict_gate",
  "final_gate",
  "standing_approval",
  "budget_decision",
]);

const MAX_DISPLAYED_SUBJECT = 200;
const LINKABLE_SEGMENT = /^[A-Za-z0-9_@+=,.-]+$/u;
const SCHEME_PREFIX = /^[A-Za-z][A-Za-z0-9+.-]*:/u;
// A project-relative path never needs these: they would let a target escape a
// Markdown link or a table cell.
const UNSAFE_PATH_CHARACTER = /[\u0000-\u001f\u007f\\]/u;

function upperFirst(value) {
  return value ? `${value[0].toUpperCase()}${value.slice(1)}` : value;
}

function compareText(left, right) {
  const a = String(left ?? "");
  const b = String(right ?? "");
  return a < b ? -1 : a > b ? 1 : 0;
}

function sortedUnique(values) {
  return [...new Set(values)].sort(compareText);
}

function asList(value) {
  return Array.isArray(value) ? value : [];
}

function count(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function text(value) {
  return typeof value === "string" ? value : "";
}

function shortSha(value) {
  const sha = text(value);
  return /^[a-f0-9]{7,64}$/iu.test(sha) ? sha.slice(0, 12) : sha;
}

/**
 * How an evidence path may appear: `link` for a plain project-relative path,
 * `text` for a project-relative path a Markdown link target cannot carry
 * safely (spaces, brackets), `drop` for anything that is not project-relative
 * at all (absolute, parent-relative, a URL or drive, or containing control
 * characters). Dropping keeps a local file-system location or a foreign URL
 * out of text that is published.
 */
export function classifyEvidencePath(value) {
  const candidate = text(value);
  if (
    !candidate
    || candidate.startsWith("/")
    || UNSAFE_PATH_CHARACTER.test(candidate)
    || SCHEME_PREFIX.test(candidate)
  ) {
    return "drop";
  }
  const segments = candidate.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return "drop";
  }
  return segments.every((segment) => LINKABLE_SEGMENT.test(segment)) ? "link" : "text";
}

function evidencePaths(...lists) {
  return sortedUnique(lists.flatMap((list) => asList(list))
    .filter((candidate) => classifyEvidencePath(candidate) !== "drop"));
}

/** The command exactly as recorded, quoted only where a shell would need it. */
export function displayCommand(argv) {
  const words = asList(argv).map((word) => {
    const value = String(word);
    return /^[A-Za-z0-9_@%+=:,./-]+$/u.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
  });
  return words.join(" ");
}

// Shortening happens when rendering, after redaction: cutting a command first
// could leave the front of a credential too short for a detector to recognise.
function shorten(value) {
  return value.length > MAX_DISPLAYED_SUBJECT ? `${value.slice(0, MAX_DISPLAYED_SUBJECT - 1)}…` : value;
}

function row(kind, status, subject, facts, evidence) {
  return { kind, status, subject, facts, evidence: evidencePaths(evidence) };
}

const RUN_STATUS = Object.freeze({ passed: "pass", failed: "fail", blocked: "not_run", skipped: "not_run" });

function runRows(kind, runs) {
  const byCommand = new Map();
  const ordered = asList(runs).slice().sort((left, right) =>
    compareText(left.finished_at, right.finished_at) || compareText(left.id, right.id));
  for (const run of ordered) {
    const command = displayCommand(run.argv);
    byCommand.set(command, [...(byCommand.get(command) || []), run]);
  }
  if (byCommand.size === 0) return [row(kind, "not_run", null, { recorded: 0 }, [])];
  return [...byCommand.entries()]
    .sort(([left], [right]) => compareText(left, right))
    .map(([command, history]) => {
      // A newer run of the same command supersedes the older ones, so a late
      // failure is never hidden behind an earlier pass.
      const latest = history.at(-1);
      const totals = latest.totals || {};
      return row(
        kind,
        RUN_STATUS[latest.outcome] || "not_run",
        command,
        {
          recorded: history.length,
          outcome: text(latest.outcome),
          exit_code: Number.isSafeInteger(latest.exit_code) ? latest.exit_code : null,
          passed: count(totals.passed),
          failed: count(totals.failed),
          skipped: count(totals.skipped),
          finished_at: text(latest.finished_at),
          earlier_runs: history.length - 1,
        },
        [latest.path, ...asList(latest.evidence)],
      );
    });
}

function secretScanRow(scans, headSha) {
  const ordered = asList(scans).slice().sort((left, right) =>
    compareText(left.finished_at, right.finished_at) || compareText(left.id, right.id));
  if (ordered.length === 0) return row("secret_scan", "not_run", null, { state: "none" }, []);
  const current = ordered.filter((scan) => scan.current !== false);
  const latest = (current.length > 0 ? current : ordered).at(-1);
  const facts = {
    state: current.length === 0 ? "stale" : latest.outcome === "clean" ? "clean" : "findings",
    scan_id: text(latest.id),
    file_count: count(latest.file_count),
    finding_count: count(latest.finding_count),
    scanned_head: text(latest.head_sha) || null,
    current_head: headSha,
  };
  const status = facts.state === "clean" ? "pass" : facts.state === "findings" ? "fail" : "not_run";
  return row("secret_scan", status, null, facts, [latest.path]);
}

function codeReviewRow(review, headSha) {
  const required = review?.required === true;
  const reviews = asList(review?.reviews).slice().sort((left, right) =>
    compareText(left.reviewed_at, right.reviewed_at) || compareText(left.id, right.id));
  if (reviews.length === 0) {
    return row("code_review", "not_run", null, { state: "none", merge_gate_required: required }, []);
  }
  const target = headSha || reviews.at(-1).reviewed_head_sha;
  const forHead = reviews.filter((candidate) => candidate.reviewed_head_sha === target);
  const base = { merge_gate_required: required, reviewed_head: target || null, current_head: headSha };
  if (forHead.length === 0) {
    return row("code_review", "not_run", null, {
      ...base,
      state: "stale",
      reviewed_head: reviews.at(-1).reviewed_head_sha || null,
    }, [reviews.at(-1).path]);
  }
  const independent = forHead.filter((candidate) => candidate.independent === true);
  if (independent.length === 0) {
    return row("code_review", "not_run", null, { ...base, state: "author_only" }, [forHead.at(-1).path]);
  }
  const latest = independent.at(-1);
  const approved = latest.verdict === "approved";
  return row("code_review", approved ? "pass" : "fail", null, {
    ...base,
    state: approved ? "approved" : "changes_requested",
    reviewer: text(latest.reviewer_id),
    finding_count: count(latest.finding_count),
    blocking_count: count(latest.blocking_count),
  }, [latest.path]);
}

function gateRow(kind, gate, storyId) {
  return gate
    ? row(kind, "pass", null, { state: "passed", story_id: storyId, checked_at: text(gate.checked_at) }, [gate.path])
    : row(kind, "not_run", null, { state: "none", story_id: storyId }, []);
}

function standingRow(standing) {
  if (!standing) return [];
  const facts = {
    standing_approval_id: text(standing.id),
    standing_status: text(standing.status),
    slot: Number.isSafeInteger(standing.slot) ? standing.slot : null,
    max_deliveries: count(standing.max_deliveries),
  };
  const broken = ["invalid", "revoked"].includes(standing.status);
  const status = standing.used !== true ? "not_run" : broken ? "fail" : "pass";
  return [row("standing_approval", status, null, { ...facts, used: standing.used === true }, standing.evidence)];
}

function budgetRow(budget) {
  const state = text(budget?.state) || "not_started";
  const facts = {
    state,
    reason_codes: sortedUnique(asList(budget?.reason_codes).map(String)),
    budget_bound: budget?.bound === true,
  };
  let status = "not_run";
  if (state === "recorded") {
    if (budget.blocked === true) status = "fail";
    else if (budget.bound === true) status = "pass";
  }
  return row("budget_decision", status, null, facts, budget?.evidence);
}

/**
 * Turn the recorded facts of one delivery into the checks model.
 *
 * Rows come out in a fixed order and a fixed internal order, so the same
 * records always produce byte-identical output.
 */
export function buildPullRequestChecks(facts) {
  const delivery = facts?.delivery || {};
  const headSha = text(facts?.head_sha) || null;
  const storyId = text(delivery.story_id);
  const checks = [
    ...runRows("tests", facts?.tests),
    ...runRows("smoke_tests", facts?.smoke_tests),
    secretScanRow(facts?.secret_scans, headSha),
    codeReviewRow(facts?.code_review, headSha),
    gateRow("strict_gate", facts?.gates?.strict, storyId),
    gateRow("final_gate", facts?.gates?.final, storyId),
    ...standingRow(facts?.standing_approval),
    budgetRow(facts?.budget),
  ];
  const summary = { pass: 0, fail: 0, not_run: 0 };
  for (const check of checks) summary[check.status] += 1;
  return {
    schema_version: PULL_REQUEST_CHECKS_SCHEMA,
    delivery: {
      profile_id: text(delivery.profile_id),
      delivery_id: text(delivery.delivery_id),
      story_id: storyId,
      repository: text(delivery.repository) || null,
      base_branch: text(delivery.base_branch) || null,
      head_branch: text(delivery.head_branch) || null,
      head_sha: headSha,
    },
    summary,
    overall: summary.fail > 0 ? "fail" : summary.not_run > 0 ? "not_run" : "pass",
    ignored_records: count(facts?.ignored_records),
    checks,
  };
}

const LABELS = Object.freeze({
  en: Object.freeze({
    title: "Delivery checks",
    columns: ["Check", "Status", "Details", "Evidence"],
    status: { pass: "[PASS]", fail: "[FAIL]", not_run: "[NOT RUN]" },
    kinds: {
      tests: "Tests",
      smoke_tests: "Smoke tests",
      secret_scan: "Secret scan",
      code_review: "Code review gate",
      strict_gate: "Strict gate",
      final_gate: "Lifecycle-complete gate",
      standing_approval: "Standing approval",
      budget_decision: "Budget decision",
    },
    outcomes: { passed: "passed", failed: "failed", blocked: "blocked", skipped: "skipped" },
    none: "none",
    unknownStatus: "unknown",
    summary: ({ delivery, profile, story, pass, fail, notRun }) =>
      `Delivery ${delivery} (profile ${profile}, story ${story}): ${pass} pass, ${fail} fail, ${notRun} not run.`,
    footer: "Generated by agentic-sdlc from the records under `.sdlc/`. Each row reports what was recorded; nothing was re-run and this table approves nothing.",
    ignored: (n) => `${n} recorded ${n === 1 ? "file" : "files"} failed validation and ${n === 1 ? "was" : "were"} left out.`,
    headUnresolved: "The delivery head branch is not checked out here, so recorded checks are listed without comparing them to the current head.",
    detail: {
      run: ({ command, outcome, exit, passed, failed, skipped, at, earlier }) =>
        `${command}: ${outcome} (exit ${exit}; ${passed} passed, ${failed} failed, ${skipped} skipped), recorded ${at}${earlier
          ? ` (+${earlier} earlier ${earlier === 1 ? "run" : "runs"})`
          : ""}`,
      testsNone: "No test run is recorded for this delivery.",
      smokeNone: "No smoke test run is recorded for this delivery. Record one with `test record --framework smoke`.",
      scanClean: ({ files, head }) => `Clean: ${files} ${files === 1 ? "file" : "files"} scanned${head}`,
      scanFindings: ({ findings, files }) =>
        `${findings} credential ${findings === 1 ? "match" : "matches"} in ${files} scanned ${files === 1 ? "file" : "files"}; matches are never shown`,
      scanStale: ({ scanned, current }) =>
        `The latest scan covers ${scanned || "an earlier state"}, not the current state${current ? ` (${current})` : ""}; scan again`,
      scanNone: "No secret scan is recorded for this delivery.",
      atHead: (head) => ` at head ${head}`,
      reviewApproved: ({ reviewer, head, findings }) =>
        `Approved by ${reviewer} at head ${head}${findings ? `; ${findings} ${findings === 1 ? "finding" : "findings"}` : ""}`,
      reviewChanges: ({ reviewer, head, blocking }) =>
        `Changes requested by ${reviewer} at head ${head} (${blocking} blocking)`,
      reviewAuthorOnly: ({ head }) =>
        `Only an author of the pull request reviewed head ${head}; an independent review is needed`,
      reviewStale: ({ reviewed, current }) =>
        `The latest review covers head ${reviewed}, not the current head ${current}`,
      reviewNone: "No code review is recorded for this delivery.",
      mergeGate: (required) => (required ? " Merge gate: required." : " Merge gate: not required by project policy."),
      gatePassed: (name, at) => `${upperFirst(name)} passed; receipt sealed ${at}`,
      gateNone: (name, story) => `No passing ${name} receipt is recorded for story ${story}.`,
      gateStrictName: "strict story gate",
      gateFinalName: "lifecycle-complete gate",
      standingUsed: ({ id, slot, max, status }) =>
        `${id}: delivery slot ${slot} of ${max}; the standing approval is now ${status}`,
      standingBroken: ({ id, status }) => `${id} is ${status}; it no longer covers this delivery`,
      standingUnused: (id) => `${id} is referenced but no delivery slot is recorded for this delivery.`,
      budgetNotStarted: "The delivery has not started, so no budget decision is recorded.",
      budgetUnavailable: "The recorded start decision could not be read.",
      budgetBlocked: (codes) => `The start decision was stopped by the budget${codes ? ` (${codes})` : ""}.`,
      budgetBound: "An execution budget is bound and allowed the start; delivery usage is not metered, so the level stays capped at checkpointed.",
      budgetUnbound: "No execution budget is bound to this delivery, so the start decision was not limited by a budget.",
    },
  }),
  it: Object.freeze({
    title: "Controlli della consegna",
    columns: ["Controllo", "Stato", "Dettagli", "Prove"],
    status: { pass: "[SUPERATO]", fail: "[FALLITO]", not_run: "[NON ESEGUITO]" },
    kinds: {
      tests: "Test",
      smoke_tests: "Smoke test",
      secret_scan: "Scansione dei segreti",
      code_review: "Gate di revisione del codice",
      strict_gate: "Gate strict",
      final_gate: "Gate di ciclo completo",
      standing_approval: "Approvazione permanente",
      budget_decision: "Decisione sul budget",
    },
    outcomes: { passed: "superato", failed: "fallito", blocked: "bloccato", skipped: "saltato" },
    none: "nessuno",
    unknownStatus: "sconosciuto",
    summary: ({ delivery, profile, story, pass, fail, notRun }) =>
      `Consegna ${delivery} (profilo ${profile}, story ${story}): ${pass} superati, ${fail} falliti, ${notRun} non eseguiti.`,
    footer: "Generato da agentic-sdlc dai record in `.sdlc/`. Ogni riga riporta ciò che è stato registrato; nulla è stato rieseguito e questa tabella non approva nulla.",
    ignored: (n) => (n === 1
      ? "1 file registrato non ha superato la validazione ed è stato escluso."
      : `${n} file registrati non hanno superato la validazione e sono stati esclusi.`),
    headUnresolved: "Il branch sorgente della consegna non è in uso qui, quindi i controlli registrati sono elencati senza confrontarli con l’head corrente.",
    detail: {
      run: ({ command, outcome, exit, passed, failed, skipped, at, earlier }) =>
        `${command}: ${outcome} (uscita ${exit}; ${passed} superati, ${failed} falliti, ${skipped} saltati), registrato ${at}${earlier
          ? ` (+${earlier} ${earlier === 1 ? "esecuzione precedente" : "esecuzioni precedenti"})`
          : ""}`,
      testsNone: "Nessuna esecuzione di test è registrata per questa consegna.",
      smokeNone: "Nessuna esecuzione di smoke test è registrata per questa consegna. Registrane una con `test record --framework smoke`.",
      scanClean: ({ files, head }) => `Pulita: ${files} file analizzati${head}`,
      scanFindings: ({ findings, files }) =>
        `${findings} ${findings === 1 ? "corrispondenza" : "corrispondenze"} di credenziali in ${files} file analizzati; le corrispondenze non vengono mai mostrate`,
      scanStale: ({ scanned, current }) =>
        `L’ultima scansione riguarda ${scanned || "uno stato precedente"}, non lo stato corrente${current ? ` (${current})` : ""}; esegui di nuovo la scansione`,
      scanNone: "Nessuna scansione dei segreti è registrata per questa consegna.",
      atHead: (head) => ` sull’head ${head}`,
      reviewApproved: ({ reviewer, head, findings }) =>
        `Approvata da ${reviewer} sull’head ${head}${findings ? `; ${findings} ${findings === 1 ? "osservazione" : "osservazioni"}` : ""}`,
      reviewChanges: ({ reviewer, head, blocking }) =>
        `Modifiche richieste da ${reviewer} sull’head ${head} (${blocking} bloccanti)`,
      reviewAuthorOnly: ({ head }) =>
        `Solo un autore della pull request ha revisionato l’head ${head}; serve una revisione indipendente`,
      reviewStale: ({ reviewed, current }) =>
        `L’ultima revisione riguarda l’head ${reviewed}, non l’head corrente ${current}`,
      reviewNone: "Nessuna revisione del codice è registrata per questa consegna.",
      mergeGate: (required) => (required ? " Gate di merge: richiesto." : " Gate di merge: non richiesto dalla policy del progetto."),
      gatePassed: (name, at) => `${upperFirst(name)} superato; ricevuta sigillata ${at}`,
      gateNone: (name, story) => `Nessuna ricevuta di ${name} superato è registrata per la story ${story}.`,
      gateStrictName: "gate strict della story",
      gateFinalName: "gate di ciclo completo",
      standingUsed: ({ id, slot, max, status }) =>
        `${id}: posto di consegna ${slot} di ${max}; l’approvazione permanente ora è ${status}`,
      standingBroken: ({ id, status }) => `${id} è ${status}; non copre più questa consegna`,
      standingUnused: (id) => `${id} è referenziata ma nessun posto di consegna è registrato per questa consegna.`,
      budgetNotStarted: "La consegna non è iniziata, quindi non è registrata alcuna decisione sul budget.",
      budgetUnavailable: "La decisione di avvio registrata non è leggibile.",
      budgetBlocked: (codes) => `La decisione di avvio è stata fermata dal budget${codes ? ` (${codes})` : ""}.`,
      budgetBound: "Un budget di esecuzione è collegato e ha consentito l’avvio; l’utilizzo delle consegne non è misurato, quindi il livello resta limitato a checkpointed.",
      budgetUnbound: "Nessun budget di esecuzione è collegato a questa consegna, quindi la decisione di avvio non era limitata da un budget.",
    },
  }),
});

function labelsFor(locale) {
  const normalized = String(locale ?? "en").trim().toLowerCase().split(/[-_]/u)[0];
  return LABELS[normalized] || LABELS.en;
}

/** A plain value placed in a table cell: one line, with every pipe escaped. */
function plain(value) {
  return String(value ?? "").replace(/\r\n|\r|\n/gu, " ").replaceAll("|", "\\|").trim();
}

/** A code span that survives backticks in its content and stays inside one table cell. */
function codeSpan(value) {
  const content = String(value).replace(/\r\n|\r|\n/gu, " ").replaceAll("|", "\\|");
  const longest = Math.max(0, ...(content.match(/`+/gu) || []).map((run) => run.length));
  const fence = "`".repeat(longest + 1);
  const padding = content.startsWith("`") || content.endsWith("`") ? " " : "";
  return `${fence}${padding}${content}${padding}${fence}`;
}

function evidenceCell(paths, labels) {
  if (!paths.length) return labels.none;
  return paths
    .map((entry) => (classifyEvidencePath(entry) === "link"
      ? `[${codeSpan(entry)}](${entry})`
      : codeSpan(entry)))
    .join("<br>");
}

function head(value, labels) {
  return value ? codeSpan(shortSha(value)) : labels.unknownStatus;
}

function describeRow(check, delivery, labels) {
  const detail = labels.detail;
  const facts = check.facts || {};
  switch (check.kind) {
    case "tests":
    case "smoke_tests":
      if (!facts.recorded) return check.kind === "tests" ? detail.testsNone : detail.smokeNone;
      return detail.run({
        command: codeSpan(shorten(String(check.subject))),
        outcome: plain(labels.outcomes[facts.outcome] || facts.outcome || labels.unknownStatus),
        exit: plain(facts.exit_code ?? labels.unknownStatus),
        passed: facts.passed,
        failed: facts.failed,
        skipped: facts.skipped,
        at: plain(facts.finished_at || labels.unknownStatus),
        earlier: facts.earlier_runs,
      });
    case "secret_scan":
      if (facts.state === "clean") {
        return detail.scanClean({
          files: facts.file_count,
          head: facts.scanned_head ? detail.atHead(codeSpan(shortSha(facts.scanned_head))) : "",
        });
      }
      if (facts.state === "findings") return detail.scanFindings({ findings: facts.finding_count, files: facts.file_count });
      if (facts.state === "stale") {
        return detail.scanStale({
          scanned: facts.scanned_head ? codeSpan(shortSha(facts.scanned_head)) : "",
          current: facts.current_head ? codeSpan(shortSha(facts.current_head)) : "",
        });
      }
      return detail.scanNone;
    case "code_review": {
      const gate = detail.mergeGate(facts.merge_gate_required === true);
      switch (facts.state) {
        case "approved":
          return `${detail.reviewApproved({ reviewer: codeSpan(facts.reviewer), head: head(facts.reviewed_head, labels), findings: facts.finding_count })}.${gate}`;
        case "changes_requested":
          return `${detail.reviewChanges({ reviewer: codeSpan(facts.reviewer), head: head(facts.reviewed_head, labels), blocking: facts.blocking_count })}.${gate}`;
        case "author_only":
          return `${detail.reviewAuthorOnly({ head: head(facts.reviewed_head, labels) })}.${gate}`;
        case "stale":
          return `${detail.reviewStale({ reviewed: head(facts.reviewed_head, labels), current: head(facts.current_head, labels) })}.${gate}`;
        default:
          return `${detail.reviewNone}${gate}`;
      }
    }
    case "strict_gate":
    case "final_gate": {
      const name = check.kind === "strict_gate" ? detail.gateStrictName : detail.gateFinalName;
      return facts.state === "passed"
        ? detail.gatePassed(name, plain(facts.checked_at || labels.unknownStatus))
        : detail.gateNone(name, codeSpan(facts.story_id || delivery.story_id));
    }
    case "standing_approval": {
      const id = codeSpan(facts.standing_approval_id);
      if (!facts.used) return detail.standingUnused(id);
      return ["invalid", "revoked"].includes(facts.standing_status)
        ? detail.standingBroken({ id, status: plain(facts.standing_status) })
        : detail.standingUsed({
          id,
          slot: plain(facts.slot ?? labels.unknownStatus),
          max: facts.max_deliveries,
          status: plain(facts.standing_status || labels.unknownStatus),
        });
    }
    case "budget_decision":
      if (facts.state === "not_started") return detail.budgetNotStarted;
      if (facts.state !== "recorded") return detail.budgetUnavailable;
      if (check.status === "fail") {
        return detail.budgetBlocked(asList(facts.reason_codes).map(codeSpan).join(", "));
      }
      return facts.budget_bound ? detail.budgetBound : detail.budgetUnbound;
    default:
      return labels.unknownStatus;
  }
}

/**
 * The model as a Markdown section: a heading, one summary line, a four-column
 * table, and a short provenance note. Evidence is linked only when it is a
 * plain project-relative path.
 */
export function renderPullRequestChecksMarkdown(model, { locale = "en" } = {}) {
  const labels = labelsFor(locale);
  const delivery = model.delivery || {};
  const summary = model.summary || { pass: 0, fail: 0, not_run: 0 };
  const lines = [
    `## ${labels.title}`,
    "",
    labels.summary({
      delivery: codeSpan(delivery.delivery_id),
      profile: codeSpan(delivery.profile_id),
      story: codeSpan(delivery.story_id),
      pass: summary.pass,
      fail: summary.fail,
      notRun: summary.not_run,
    }),
    "",
    `| ${labels.columns.join(" | ")} |`,
    `| ${labels.columns.map(() => "---").join(" | ")} |`,
  ];
  for (const check of asList(model.checks)) {
    lines.push(`| ${[
      plain(labels.kinds[check.kind] || check.kind),
      labels.status[check.status] || labels.status.not_run,
      describeRow(check, delivery, labels),
      evidenceCell(asList(check.evidence), labels),
    ].join(" | ")} |`);
  }
  lines.push("");
  if (!delivery.head_sha) lines.push(labels.headUnresolved, "");
  if (model.ignored_records > 0) lines.push(labels.ignored(model.ignored_records), "");
  lines.push(`_${labels.footer}_`);
  return `${lines.join("\n")}\n`;
}
