import assert from "node:assert/strict";
import test from "node:test";

import {
  displayTextForItem,
  humanGuidanceForItem,
  humanGuidanceTextForItem,
  localeFromLocation,
  localizedErrorGuidance,
  setLocale,
  t,
} from "../../ui/change-observatory/i18n.js";
import { ObservatoryApiError } from "../../ui/change-observatory/api.js";
import {
  renderFatalError,
  renderDiagnostics,
  renderInspector,
  renderPrimary,
  renderSummary,
} from "../../ui/change-observatory/components.js";

const TECHNICAL_ONLY = /\b(?:bounded-autonomous|checkpoint(?:ed|_required)|audit_only|host_verified|profile|receipt|ceiling|schema|hash|reason[ _-]?code|AUT-[A-Z0-9-]+)\b/iu;

const autonomyDecision = Object.freeze({
  id: "AUT-DEC-GOLDEN",
  type: "autonomy-decision",
  title: "Autonomy decision AUT-DEC-GOLDEN",
  summary: "requested bounded-autonomous; effective checkpointed; reasons: authority.audit_only_cap.",
  status: "checkpoint_required",
});

const technicalNonAutonomyRecord = Object.freeze({
  id: "AUT-GATE-HUMAN-READABLE",
  type: "gate",
  title: "AUT-GATE-HUMAN-READABLE under audit_only authority",
  summary: "The bounded-autonomous ceiling resolves to checkpoint_required.",
  status: "checkpoint_required",
  provenance: "recorded",
  sourceRefs: [],
});

class FakeNode {
  constructor(tagName = null, text = "") {
    this.tagName = tagName;
    this.children = [];
    this.attributes = new Map();
    this.dataset = {};
    this.className = "";
    this._text = String(text ?? "");
  }

  append(...children) {
    this.children.push(...children.filter((child) => child !== null && child !== undefined));
  }

  replaceChildren(...children) {
    this.children = children.filter((child) => child !== null && child !== undefined);
    this._text = "";
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  get textContent() {
    return `${this._text}${this.children.map((child) => child.textContent ?? "").join("")}`;
  }

  set textContent(value) {
    this._text = String(value ?? "");
    this.children = [];
  }
}

function fakeDocument() {
  return {
    createElement: (tagName) => new FakeNode(tagName),
    createElementNS: (_namespace, tagName) => new FakeNode(tagName),
    createTextNode: (text) => new FakeNode(null, text),
  };
}

function descendants(root, predicate) {
  const found = [];
  const visit = (current) => {
    if (predicate(current)) found.push(current);
    for (const child of current?.children ?? []) visit(child);
  };
  visit(root);
  return found;
}

function hasClass(value, className) {
  return String(value ?? "").split(/\s+/u).includes(className);
}

function primaryText(root) {
  const read = (current) => {
    if (current?.tagName === "details") return "";
    return `${current?._text ?? ""}${(current?.children ?? []).map(read).join("")}`;
  };
  return read(root);
}

function autonomyItem(type, status, suffix = status) {
  return {
    id: `AUT-${suffix.toUpperCase()}`,
    type,
    title: `Internal ${suffix} record`,
    summary: "bounded-autonomous audit_only receipt",
    status,
    provenance: "recorded",
    sourceRefs: [],
  };
}

test("reads only supported locale values from the safe browser query", () => {
  assert.equal(localeFromLocation({ search: "?locale=it" }), "it");
  assert.equal(localeFromLocation({ search: "?locale=it-IT" }), "it");
  assert.equal(localeFromLocation({ search: "?locale=fr&access_token=forbidden" }), "en");
});

test("English autonomy journey is human-first and keeps internal vocabulary after the divider", () => {
  const rendered = humanGuidanceTextForItem(autonomyDecision, "en");
  const [human, technical] = rendered.split("Technical details (optional):");

  assert.match(human, /^Outcome: Work reached a point that needs review\./u);
  assert.match(human, /Impact: The next protected action will not run automatically\./u);
  assert.match(human, /Decision: Review the evidence and confirm whether you want to continue\./u);
  assert.match(human, /Protection: Merge, release, production, secrets/u);
  assert.match(human, /Next action: Open the technical evidence/u);
  assert.doesNotMatch(human, TECHNICAL_ONLY);
  assert.match(technical, /AUT-DEC-GOLDEN/u);
  assert.match(technical, /bounded-autonomous/u);
  assert.match(technical, /audit_only/u);
});

test("Italian autonomy journey is complete, understandable, and keeps internal vocabulary secondary", () => {
  const rendered = humanGuidanceTextForItem(autonomyDecision, "it");
  const [human, technical] = rendered.split("Dettagli tecnici (facoltativi):");

  assert.match(human, /^Risultato: Il lavoro è arrivato a un punto che richiede una verifica\./u);
  assert.match(human, /Cosa cambia in pratica: L’azione protetta successiva non verrà eseguita automaticamente\./u);
  assert.match(human, /Cosa devi decidere: Verifica le prove e conferma se vuoi proseguire\./u);
  assert.match(human, /Cosa resta protetto: Unione, rilascio, produzione, segreti/u);
  assert.match(human, /Prossimo passo: Apri le prove tecniche/u);
  assert.doesNotMatch(human, TECHNICAL_ONLY);
  assert.match(technical, /AUT-DEC-GOLDEN/u);
  assert.match(technical, /bounded-autonomous/u);
  assert.match(technical, /audit_only/u);
});

test("autonomy list copy never promotes IDs or internal levels", () => {
  for (const locale of ["en", "it"]) {
    setLocale(locale);
    const display = displayTextForItem(autonomyDecision);
    assert.doesNotMatch(`${display.title}\n${display.summary}`, TECHNICAL_ONLY);
  }
});

test("non-autonomy records use one human projection in summary, list, and inspector", (t) => {
  const previousDocument = globalThis.document;
  globalThis.document = fakeDocument();
  t.after(() => {
    globalThis.document = previousDocument;
    setLocale("en");
  });

  for (const locale of ["en", "it"]) {
    setLocale(locale);
    const display = displayTextForItem(technicalNonAutonomyRecord);
    assert.doesNotMatch(Object.values(display).join("\n"), TECHNICAL_ONLY, `${locale}/projection`);

    const guidanceText = humanGuidanceTextForItem(technicalNonAutonomyRecord, locale);
    const divider = locale === "it"
      ? "Dettagli tecnici (facoltativi):"
      : "Technical details (optional):";
    const [human, technical] = guidanceText.split(divider);
    assert.doesNotMatch(human, TECHNICAL_ONLY, `${locale}/guidance`);
    for (const canonical of ["AUT-GATE-HUMAN-READABLE", "audit_only", "bounded-autonomous", "checkpoint_required"]) {
      assert.match(technical, new RegExp(canonical), `${locale}/technical/${canonical}`);
    }

    const summary = new FakeNode("main");
    renderSummary(summary, {
      summary: {
        asked: [technicalNonAutonomyRecord],
        changed: [],
        decided: [],
      },
    });
    assert.doesNotMatch(primaryText(summary), TECHNICAL_ONLY, `${locale}/summary`);
    assert.match(
      descendants(summary, (node) => node.tagName === "details")[0].textContent,
      /AUT-GATE-HUMAN-READABLE[\s\S]*audit_only[\s\S]*bounded-autonomous/u,
      `${locale}/summary technical details`,
    );

    const list = new FakeNode("main");
    renderPrimary(list, { verification: [technicalNonAutonomyRecord] }, {
      view: "verification",
      selectedId: null,
      filters: {},
    });
    assert.doesNotMatch(primaryText(list), TECHNICAL_ONLY, `${locale}/list`);

    const inspector = new FakeNode("aside");
    renderInspector(inspector, technicalNonAutonomyRecord);
    assert.doesNotMatch(primaryText(inspector), TECHNICAL_ONLY, `${locale}/inspector`);
    const inspectorDetails = descendants(inspector, (node) => node.tagName === "details")[0];
    assert.match(inspectorDetails.textContent, /AUT-GATE-HUMAN-READABLE/u);
    assert.match(inspectorDetails.textContent, /checkpoint_required/u);
  }
});

test("absolute paths and executable command lines remain only in optional technical details", (t) => {
  const previousDocument = globalThis.document;
  globalThis.document = fakeDocument();
  t.after(() => {
    globalThis.document = previousDocument;
    setLocale("en");
  });

  const literals = [
    "/Users/antonioantenore/Documents/TravelOps/package.json",
    String.raw`C:\TravelOps\package.json`,
    String.raw`\\build-server\TravelOps\package.json`,
    "npm test",
  ];

  for (const locale of ["en", "it"]) {
    setLocale(locale);
    for (const [index, literal] of literals.entries()) {
      const item = {
        id: `REQ-LITERAL-${index}`,
        type: "requirement",
        title: `Recorded instruction: ${literal}`,
        summary: `Use ${literal} before continuing.`,
        humanStatus: `Ready after ${literal}`,
        status: "proposed",
        provenance: "recorded",
        sourceRefs: [],
      };
      const display = displayTextForItem(item);
      assert.ok(
        Object.values(display).every((value) => !String(value).includes(literal)),
        `${locale}/${literal}/projection`,
      );

      const guidanceText = humanGuidanceTextForItem(item, locale);
      const divider = locale === "it"
        ? "Dettagli tecnici (facoltativi):"
        : "Technical details (optional):";
      const [human, technical] = guidanceText.split(divider);
      assert.ok(!human.includes(literal), `${locale}/${literal}/guidance`);
      assert.ok(technical.includes(literal), `${locale}/${literal}/guidance technical details`);

      const summary = new FakeNode("main");
      renderSummary(summary, { summary: { asked: [item], changed: [], decided: [] } });
      assert.ok(!primaryText(summary).includes(literal), `${locale}/${literal}/summary`);
      assert.ok(
        descendants(summary, (node) => node.tagName === "details")[0].textContent.includes(literal),
        `${locale}/${literal}/summary technical details`,
      );

      const inspector = new FakeNode("aside");
      renderInspector(inspector, item);
      assert.ok(!primaryText(inspector).includes(literal), `${locale}/${literal}/inspector`);
      assert.ok(
        descendants(inspector, (node) => node.tagName === "details")[0].textContent.includes(literal),
        `${locale}/${literal}/inspector technical details`,
      );
    }
  }
});

test("approval and correction next actions direct people back to the agent conversation", (t) => {
  const previousDocument = globalThis.document;
  globalThis.document = fakeDocument();
  t.after(() => {
    globalThis.document = previousDocument;
    setLocale("en");
  });

  const items = [
    autonomyItem("requirement-execution-profile", "proposed", "REQ-PROPOSED-ACTION"),
    autonomyItem("requirement-execution-profile", "active", "REQ-ACTIVE-ACTION"),
    autonomyItem("requirement-execution-profile", "revoked", "REQ-REVOKED-ACTION"),
    autonomyItem("requirement-execution-profile", "closed", "REQ-CLOSED-ACTION"),
    autonomyItem("requirement-execution-profile", "unknown", "REQ-UNKNOWN-ACTION"),
    autonomyItem("delivery-execution-profile", "proposed", "DEL-PROPOSED-ACTION"),
    autonomyItem("delivery-execution-profile", "revoked", "DEL-REVOKED-ACTION"),
    autonomyItem("delivery-execution-profile", "closed", "DEL-CLOSED-ACTION"),
    autonomyItem("delivery-execution-profile", "unknown", "DEL-UNKNOWN-ACTION"),
    autonomyItem("autonomy-decision", "checkpoint_required", "DEC-CHECKPOINT-ACTION"),
    {
      id: "REQ-GENERIC-PROPOSED-ACTION",
      type: "requirement",
      title: "Proposed project request",
      summary: "A person still needs to decide.",
      status: "proposed",
      provenance: "recorded",
      sourceRefs: [],
    },
  ];

  for (const locale of ["en", "it"]) {
    setLocale(locale);
    const expected = locale === "it"
      ? /conversazione con il tuo agente[\s\S]*linguaggio naturale/iu
      : /your agent conversation[\s\S]*natural language/iu;
    for (const item of items) {
      const guidance = humanGuidanceForItem(item);
      assert.match(guidance.nextAction, expected, `${locale}/${item.type}/${item.status}`);
    }

    const emptySummary = new FakeNode("main");
    renderSummary(emptySummary, { summary: { asked: [], changed: [], decided: [] } });
    assert.match(primaryText(emptySummary), expected, `${locale}/missing summary`);

    const diagnostics = new FakeNode("section");
    renderDiagnostics(diagnostics, [{
      severity: "error",
      code: "malformed-record",
      message: "A record could not be read.",
      occurrences: 1,
    }]);
    const diagnosticGuidance = descendants(
      diagnostics,
      (node) => hasClass(node.className, "human-guidance-grid"),
    )[0];
    assert.match(diagnosticGuidance.textContent, expected, `${locale}/diagnostics`);
  }
});

test("requirement and delivery guidance distinguish draft, usable, revoked, and closed states", () => {
  const cases = [
    ["requirement-execution-profile", "proposed", /not approved yet/u, /non è ancora approvato/u],
    ["requirement-execution-profile", "active", /is in effect/u, /è in vigore/u],
    ["requirement-execution-profile", "approved", /was approved/u, /è stato approvato/u],
    ["requirement-execution-profile", "revoked", /was revoked/u, /è stato revocato/u],
    ["requirement-execution-profile", "closed", /is closed/u, /è chiuso/u],
    ["delivery-execution-profile", "proposed", /not approved yet/u, /non è ancora approvata/u],
    ["delivery-execution-profile", "active", /is in effect/u, /è in vigore/u],
    ["delivery-execution-profile", "approved", /was approved/u, /è stato approvato/u],
    ["delivery-execution-profile", "revoked", /was revoked/u, /è stato revocato/u],
    ["delivery-execution-profile", "closed", /is closed/u, /è chiuso/u],
  ];

  for (const [type, status, englishOutcome, italianOutcome] of cases) {
    const item = autonomyItem(type, status, `${type}-${status}`);
    setLocale("en");
    const english = humanGuidanceForItem(item);
    assert.match(english.outcome, englishOutcome, `${type}/${status}/en`);
    setLocale("it");
    const italian = humanGuidanceForItem(item);
    assert.match(italian.outcome, italianOutcome, `${type}/${status}/it`);
  }

  for (const locale of ["en", "it"]) {
    setLocale(locale);
    for (const status of ["proposed", "revoked", "closed"]) {
      for (const type of ["requirement-execution-profile", "delivery-execution-profile"]) {
        const primary = Object.values(humanGuidanceForItem(autonomyItem(type, status))).join("\n");
        assert.doesNotMatch(
          primary,
          locale === "it"
            ? /(?:il lavoro può procedere|non devi approvare|non è richiesta una decisione)/iu
            : /(?:work may proceed|you do not need to approve|no decision is required)/iu,
          `${type}/${status}/${locale}`,
        );
      }
    }
  }

  setLocale("it");
  assert.match(
    humanGuidanceForItem(autonomyItem("requirement-execution-profile", "active")).decision,
    /Per ogni pull request o rilascio locale scegli e approva separatamente/u,
  );
  setLocale("en");
});

test("summary, inspector, and error compose five human fields in English and Italian without a build", (t) => {
  const previousDocument = globalThis.document;
  globalThis.document = fakeDocument();
  t.after(() => {
    globalThis.document = previousDocument;
    setLocale("en");
  });

  for (const locale of ["en", "it"]) {
    setLocale(locale);
    const summary = new FakeNode("main");
    const proposed = autonomyItem("requirement-execution-profile", "proposed", "REQ-PROPOSED");
    const active = autonomyItem("delivery-execution-profile", "active", "DEL-ACTIVE");
    const revoked = autonomyItem("delivery-execution-profile", "revoked", "DEL-REVOKED");
    renderSummary(summary, {
      summary: { asked: [proposed], changed: [active], decided: [revoked] },
    });

    const articles = descendants(summary, (node) => node.tagName === "article");
    assert.equal(articles.length, 3, locale);
    const recordedAnswers = articles.map((article) =>
      descendants(article, (node) => hasClass(node.className, "summary-recorded-answer"))[0]);
    assert.equal(recordedAnswers.filter(Boolean).length, 3, `${locale}/recorded answers`);
    assert.equal(
      new Set(recordedAnswers.map((answer) => answer.textContent)).size,
      3,
      `${locale}/autonomy record kinds and states remain visibly distinct`,
    );
    for (const answer of recordedAnswers) assert.doesNotMatch(answer.textContent, TECHNICAL_ONLY);
    for (const article of articles) {
      const guidance = descendants(article, (node) => hasClass(node.className, "human-guidance"));
      assert.equal(guidance.length, 1, `${locale}/summary guidance`);
      assert.equal(descendants(guidance[0], (node) => node.tagName === "dt").length, 5);
      assert.equal(descendants(article, (node) => node.tagName === "details").length, 1);
    }

    const proposedPrimary = descendants(articles[0], (node) => hasClass(node.className, "human-guidance"))[0].textContent;
    const revokedPrimary = descendants(articles[2], (node) => hasClass(node.className, "human-guidance"))[0].textContent;
    const unsafeClaim = locale === "it"
      ? /(?:il lavoro può procedere|non devi approvare)/iu
      : /(?:work may proceed|you do not need to approve)/iu;
    assert.doesNotMatch(proposedPrimary, unsafeClaim);
    assert.doesNotMatch(revokedPrimary, unsafeClaim);

    for (const item of [proposed, active, revoked]) {
      const inspector = new FakeNode("aside");
      renderInspector(inspector, item);
      const guidance = descendants(inspector, (node) => hasClass(node.className, "human-guidance"));
      assert.equal(guidance.length, 1, `${locale}/${item.status}/inspector guidance`);
      assert.equal(descendants(guidance[0], (node) => node.tagName === "dt").length, 5);
      assert.equal(descendants(inspector, (node) => node.tagName === "details").length, 1);
    }

    const error = new FakeNode("main");
    renderFatalError(error, new Error("internal transport failure"));
    const errorGrid = descendants(error, (node) => hasClass(node.className, "human-guidance-grid"));
    assert.equal(errorGrid.length, 1, `${locale}/error guidance`);
    assert.equal(descendants(errorGrid[0], (node) => node.tagName === "dt").length, 5);
    const technical = descendants(error, (node) => node.tagName === "details");
    assert.equal(technical.length, 1);
    assert.match(technical[0].textContent, /internal transport failure/u);
  }
});

test("API error code and correlation stay inside localized optional technical details", (t) => {
  const previousDocument = globalThis.document;
  globalThis.document = fakeDocument();
  t.after(() => {
    globalThis.document = previousDocument;
    setLocale("en");
  });

  const correlationId = "corr-123e4567-e89b-12d3-a456-426614174000";
  const error = new ObservatoryApiError("The project history is temporarily unavailable.", {
    status: 503,
    code: "model_unavailable",
    correlationId,
  });

  for (const locale of ["en", "it"]) {
    setLocale(locale);
    const guidance = localizedErrorGuidance(error);
    const primaryGuidance = [
      guidance.outcome,
      guidance.impact,
      guidance.decision,
      guidance.protection,
      guidance.nextAction,
    ].join("\n");
    assert.doesNotMatch(primaryGuidance, /model_unavailable|corr-123e4567/u, locale);
    assert.match(guidance.technical, /model_unavailable/u, locale);
    assert.match(guidance.technical, new RegExp(correlationId, "u"), locale);
    assert.match(
      guidance.technical,
      locale === "it" ? /Codice:.*ID correlazione:/u : /Code:.*Correlation ID:/u,
      locale,
    );

    const container = new FakeNode("main");
    renderFatalError(container, error);
    assert.doesNotMatch(primaryText(container), /model_unavailable|corr-123e4567/u, locale);
    const technical = descendants(container, (node) => node.tagName === "details");
    assert.equal(technical.length, 1, locale);
    assert.match(technical[0].textContent, /model_unavailable/u, locale);
    assert.match(technical[0].textContent, new RegExp(correlationId, "u"), locale);
  }
});

test("optional error details with credential context fail closed", () => {
  setLocale("en");
  for (const message of [
    'payload {"password":"p@ssw0rd!"}',
    "account_key=opaque-account-key-material",
    "passwd=correct-horse-battery-staple",
    "secret_access_key=opaque-secret-access-key-material",
    "secret_key=opaque-secret-key-material",
    "storage_account_key=opaque-storage-account-key-material",
    "Cookie: session=abcdefghijklmnop",
    [`eyJ${"H".repeat(20)}`, "P".repeat(32), "S".repeat(43)].join("."),
  ]) {
    const guidance = localizedErrorGuidance(new Error(message));
    assert.equal(guidance.technical, "Error: Unspecified error");
    assert.doesNotMatch(guidance.technical, /p@ssw0rd|opaque-account|correct-horse|Cookie|eyJ/u);
  }
});

test("Italian rendering preserves canonical titles and summaries that resemble UI labels", (t) => {
  const previousDocument = globalThis.document;
  globalThis.document = fakeDocument();
  t.after(() => {
    globalThis.document = previousDocument;
    setLocale("en");
  });

  setLocale("it");
  const container = new FakeNode("main");
  const canonicalItems = [
    {
      id: "REQ-CANONICAL",
      type: "requirement",
      title: "Design",
      summary: "Active",
      status: "proposed",
      provenance: "recorded",
      sourceRefs: [],
    },
    {
      id: "CHANGE-CANONICAL",
      type: "implementation",
      title: "Active",
      summary: "Design",
      status: "complete",
      provenance: "recorded",
      sourceRefs: [],
    },
    {
      id: "DEC-CANONICAL",
      type: "decision",
      title: "Release",
      summary: "Approved",
      status: "approved",
      provenance: "recorded",
      sourceRefs: [],
    },
  ];
  renderSummary(container, {
    summary: {
      asked: [canonicalItems[0]],
      changed: [canonicalItems[1]],
      decided: [canonicalItems[2]],
    },
  });

  const answers = descendants(
    container,
    (node) => hasClass(node.className, "summary-recorded-answer"),
  );
  assert.equal(answers.length, 3);
  const canonicalText = answers.map((answer) => ({
    title: descendants(answer, (node) => node.tagName === "strong")[0]?.textContent,
    summary: descendants(answer, (node) => node.tagName === "p")[0]?.textContent,
  }));
  assert.deepEqual(canonicalText, [
    { title: "Design", summary: "Active" },
    { title: "Active", summary: "Design" },
    { title: "Release", summary: "Approved" },
  ]);
});

test("summary answers keep technical identifiers secondary while preserving recorded answers", (t) => {
  const previousDocument = globalThis.document;
  globalThis.document = fakeDocument();
  t.after(() => {
    globalThis.document = previousDocument;
    setLocale("en");
  });

  setLocale("it");
  const container = new FakeNode("main");
  const item = (id, type, summary) => ({
    id,
    type,
    title: id,
    summary,
    status: "missing",
    provenance: "recorded",
    sourceRefs: [],
  });
  renderSummary(container, {
    summary: {
      asked: [item("REQ-TECHNICAL-001", "requirement", "Concordare il comportamento richiesto.")],
      changed: [item("TR-TECHNICAL-002", "implementation", "Il comportamento concordato è stato implementato.")],
      decided: [item("APR-TECHNICAL-003", "approval", "La scelta è stata approvata con i limiti registrati.")],
    },
  });

  const answers = descendants(
    container,
    (node) => hasClass(node.className, "summary-recorded-answer"),
  );
  assert.deepEqual(
    answers.map((answer) => descendants(answer, (node) => node.tagName === "strong")[0]?.textContent),
    ["Richiesta registrata", "Modifica registrata", "Decisione registrata"],
  );
  assert.deepEqual(
    answers.map((answer) => descendants(answer, (node) => node.tagName === "p")[0]?.textContent),
    [
      "Concordare il comportamento richiesto.",
      "Il comportamento concordato è stato implementato.",
      "La scelta è stata approvata con i limiti registrati.",
    ],
  );
  for (const answer of answers) {
    assert.doesNotMatch(answer.textContent, /(?:REQ|TR|APR)-TECHNICAL|Mancante/u);
  }
  const technical = descendants(container, (node) => node.tagName === "details");
  assert.match(technical.map((node) => node.textContent).join("\n"), /REQ-TECHNICAL-001/u);
  assert.match(technical.map((node) => node.textContent).join("\n"), /TR-TECHNICAL-002/u);
  assert.match(technical.map((node) => node.textContent).join("\n"), /APR-TECHNICAL-003/u);
});

test("autonomy decision rows remain distinct across record kinds and states without primary jargon", (t) => {
  const previousDocument = globalThis.document;
  globalThis.document = fakeDocument();
  t.after(() => {
    globalThis.document = previousDocument;
    setLocale("en");
  });

  for (const locale of ["en", "it"]) {
    setLocale(locale);
    const container = new FakeNode("main");
    const decisions = [
      autonomyItem("requirement-execution-profile", "proposed", "REQ-PROPOSED-LIST"),
      autonomyItem("delivery-execution-profile", "active", "DEL-ACTIVE-LIST"),
      autonomyItem("autonomy-decision", "checkpoint_required", "DEC-REVIEW-LIST"),
      autonomyItem("autonomy-decision", "ready", "DEC-READY-LIST"),
      autonomyItem("delivery-execution-profile", "revoked", "DEL-REVOKED-LIST"),
    ];
    renderPrimary(container, { decisions }, {
      view: "decisions",
      selectedId: null,
      filters: {},
    });

    const rows = descendants(container, (node) => hasClass(node.className, "list-row"));
    assert.equal(rows.length, decisions.length, locale);
    assert.equal(new Set(rows.map((row) => row.textContent)).size, decisions.length, locale);
    for (const row of rows) assert.doesNotMatch(row.textContent, TECHNICAL_ONLY, locale);
  }
});

test("principal browser chrome has English and Italian labels", () => {
  const labels = [
    "Overview",
    "Timeline",
    "Contracts",
    "Decisions",
    "Changes",
    "Intent evidence",
    "Verification",
    "What was asked?",
    "What changed?",
    "Why was it decided?",
    "Technical details (optional)",
  ];
  setLocale("it");
  for (const label of labels) assert.notEqual(t(label), label, label);
  setLocale("en");
  for (const label of labels) assert.equal(t(label), label, label);
});
