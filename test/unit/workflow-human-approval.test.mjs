import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CLI = path.join(ROOT, "bin", "agentic-sdlc.mjs");
const TEMPORARY_DIRECTORIES = new Set();

after(() => {
  for (const directory of TEMPORARY_DIRECTORIES) fs.rmSync(directory, { recursive: true, force: true });
});

function temporaryProject(label) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `agentic-sdlc-human-workflow-${label}-`));
  TEMPORARY_DIRECTORIES.add(directory);
  return directory;
}

function run(args, cwd) {
  const env = { ...process.env };
  for (const key of ["CI", "GITHUB_ACTIONS", "GITHUB_ACTOR", "CODEX_AGENT_NAME", "CODEX_USER_ID", "CLAUDECODE", "AGENTIC_SDLC_AGENT_HOST"]) delete env[key];
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: "utf8",
    env,
    timeout: 30_000,
  });
}

function mustRun(args, cwd) {
  const result = run(args, cwd);
  assert.equal(result.status, 0, `${args.join(" ")}\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  return result.stdout;
}

function primaryText(output, locale) {
  const divider = locale === "it" ? "Dettagli tecnici (facoltativi):" : "Technical details (optional):";
  assert.match(output, new RegExp(divider.replace(/[()]/gu, "\\$&"), "u"));
  return output.split(divider)[0];
}

function assertNoImplementationVocabulary(primary, hiddenIds = []) {
  assert.doesNotMatch(primary, /\b(?:workflow|overlay|definition|schema|hash|profile|receipt|bounded-autonomous|checkpoint(?:ed)?|audit_only)\b/iu);
  assert.doesNotMatch(primary, /\.sdlc\/|--[a-z]|sha256/iu);
  for (const id of hiddenIds) assert.equal(primary.includes(id), false, `primary explanation leaked ${id}`);
}

test("definition review explains the exact process before and after approval in English and Italian", () => {
  const project = temporaryProject("definition");
  mustRun(["init", "--root", project, "--project-name", "Human approval"], project);

  const englishProposal = mustRun([
    "workflow", "definition", "propose",
    "--root", project,
    "--id", "guided-assessment",
    "--definition-version", "1",
    "--workflow-preset", "technical-assessment",
    "--locale", "en",
  ], project);
  const englishPrimary = primaryText(englishProposal, "en");
  assert.match(englishPrimary, /Main sequence: Context Pending → Proposal Pending → Authorized → Running → Verifying → Completed\./u);
  assert.match(englishPrimary, /Starting point: Context Pending\./u);
  assert.match(englishPrimary, /Checks and conditions: To move from Context Pending to Proposal Pending/u);
  assert.match(englishPrimary, /Context review must be confirmed/u);
  assert.match(englishPrimary, /Usual review moments: Context, Combined Proposal\./u);
  assertNoImplementationVocabulary(englishPrimary, ["guided-assessment", "technical-assessment"]);

  const proposedShow = primaryText(mustRun([
    "workflow", "definition", "show",
    "--root", project,
    "--id", "guided-assessment",
    "--definition-version", "1",
    "--locale", "en",
  ], project), "en");
  assert.match(proposedShow, /Decide whether to confirm the displayed steps and checks or request a correction/u);
  assert.match(proposedShow, /Descriptive content to confirm:/u);

  const italianApproval = mustRun([
    "workflow", "definition", "approve",
    "--root", project,
    "--id", "guided-assessment",
    "--definition-version", "1",
    "--actor-type", "human",
    "--approval-source", "explicit-user",
    "--summary", "Confermati passaggi, condizioni e momenti di revisione mostrati",
    "--locale", "it",
  ], project);
  const italianPrimary = primaryText(italianApproval, "it");
  assert.match(italianPrimary, /Percorso principale: Contesto da confermare → Proposta da confermare → Autorizzato → In esecuzione → In verifica → Completato\./u);
  assert.match(italianPrimary, /Punto di partenza: Contesto da confermare\./u);
  assert.match(italianPrimary, /Controlli e condizioni: Per passare da Contesto da confermare a Proposta da confermare/u);
  assert.match(italianPrimary, /deve essere confermata la revisione Contesto/u);
  assert.match(italianPrimary, /Momenti ordinari di conferma: Contesto, Proposta completa\./u);
  assert.match(italianPrimary, /scopo: “Processo governato predefinito per una valutazione tecnica\.”/u);
  assert.doesNotMatch(italianPrimary, /\b(?:Context Pending|Proposal Pending|Authorized|Running|Verifying|Order)\b/u);
  assertNoImplementationVocabulary(italianPrimary, ["guided-assessment", "technical-assessment"]);

  const approvedShow = primaryText(mustRun([
    "workflow", "definition", "show",
    "--root", project,
    "--id", "guided-assessment",
    "--definition-version", "1",
    "--locale", "it",
  ], project), "it");
  assert.match(approvedShow, /modo di lavorare già confermato/u);
  assert.match(approvedShow, /Questa consultazione non richiede alcuna decisione/u);
  assert.match(approvedShow, /Contenuto descrittivo:/u);
  assert.doesNotMatch(approvedShow, /approva la proposta|da confermare:/iu);
});

test("adjustment proposal, approval, and explanation state every visible difference without technical leakage", () => {
  const project = temporaryProject("adjustment");
  mustRun(["init", "--root", project, "--project-name", "Human adjustment approval"], project);
  mustRun([
    "workflow", "definition", "propose",
    "--root", project,
    "--id", "review-process",
    "--definition-version", "1",
    "--workflow-preset", "generic-governed-process",
  ], project);
  mustRun([
    "workflow", "definition", "approve",
    "--root", project,
    "--id", "review-process",
    "--definition-version", "1",
    "--actor-type", "human",
    "--approval-source", "explicit-user",
    "--summary", "Approved the displayed process",
  ], project);

  const adjustment = JSON.stringify({
    label: "Team review process",
    description: "Peer review is required before execution.",
    state_overrides: [{
      state_id: "review",
      label: "Peer review",
      metadata: {
        order: 20,
        owners: ["Architecture", "Delivery"],
        review_settings: { mode: "plain", required: true },
      },
    }],
    transition_overrides: [{
      transition_id: "approve",
      label: "Team approval decision",
      guard_parameters: [{ guard_id: "context-equals", parameters: { key: "team_authorized", value: true } }],
      metadata: {
        audience: "review board",
        escalation: { after_days: 2, channels: ["email", "chat"] },
      },
    }],
    metadata: {
      audience: "delivery team",
      regions: ["Italy", "France"],
      policy: { review_days: 2, mandatory: true },
    },
  });
  const proposal = mustRun([
    "workflow", "overlay", "propose",
    "--root", project,
    "--id", "review-wording",
    "--overlay-version", "1",
    "--definition", "review-process",
    "--definition-version", "1",
    "--overlay-json", adjustment,
    "--locale", "en",
  ], project);
  const proposalPrimary = primaryText(proposal, "en");
  assert.match(proposalPrimary, /Main sequence: Draft → Peer Review → Approved → Execution → Verification → Completed\./u);
  assert.match(proposalPrimary, /Starting point: Draft\./u);
  assert.match(proposalPrimary, /Checks and conditions: To move from Peer Review to Approved/u);
  assert.match(proposalPrimary, /Team Authorized must be yes/u);
  assert.match(proposalPrimary, /What this adjustment changes:/u);
  assert.match(proposalPrimary, /displayed name changes from “Generic governed process” to “Team review process”/u);
  assert.match(proposalPrimary, /displayed description changes from “Generic governed process governed process preset\.” to “Peer review is required before execution\.”/u);
  assert.match(proposalPrimary, /“Review” step is shown as “Peer Review”/u);
  assert.match(proposalPrimary, /route from “Peer Review” to “Approved” is shown as “Team approval decision”/u);
  assert.match(proposalPrimary, /information for the “Peer Review” step: Order changes from 2 to 20/u);
  assert.match(proposalPrimary, /Owners is set to list \(“Architecture”, “Delivery”\)/u);
  assert.match(proposalPrimary, /Review Settings is set to details \(Mode = “plain”; Required = yes\)/u);
  assert.match(proposalPrimary, /information for the route from “Peer Review” to “Approved”: Audience is set to “review board”/u);
  assert.match(proposalPrimary, /Escalation is set to details \(After Days = 2; Channels = list \(“email”, “chat”\)\)/u);
  assert.match(proposalPrimary, /general information: Audience is set to “delivery team”/u);
  assert.match(proposalPrimary, /Regions is set to list \(“Italy”, “France”\)/u);
  assert.match(proposalPrimary, /Policy is set to details \(Mandatory = yes; Review Days = 2\)/u);
  assertNoImplementationVocabulary(proposalPrimary, ["review-process", "review-wording", "context-equals"]);

  const approval = mustRun([
    "workflow", "overlay", "approve",
    "--root", project,
    "--id", "review-wording",
    "--overlay-version", "1",
    "--actor-type", "human",
    "--approval-source", "explicit-user",
    "--summary", "Confermate tutte le differenze mostrate",
    "--locale", "it",
  ], project);
  const approvalPrimary = primaryText(approval, "it");
  assert.match(approvalPrimary, /Cosa cambia con questo adattamento:/u);
  assert.match(approvalPrimary, /il passaggio “Revisione” viene mostrato come “Peer Review”/u);
  assert.match(approvalPrimary, /Autorizzazione del team deve essere sì/u);
  assert.match(approvalPrimary, /la descrizione mostrata cambia da “Processo governato generico predefinito\.” a “Peer review is required before execution\.”/u);
  assert.match(approvalPrimary, /informazioni del passaggio “Peer Review”: Ordine cambia da 2 a 20/u);
  assert.match(approvalPrimary, /Responsabili viene impostato su elenco \(“Architecture”, “Delivery”\)/u);
  assert.match(approvalPrimary, /informazioni generali: Destinatari viene impostato su “delivery team”/u);
  assert.match(approvalPrimary, /Regole viene impostato su dettagli \(Obbligatorio = sì; Giorni per la revisione = 2\)/u);
  assertNoImplementationVocabulary(approvalPrimary, ["review-process", "review-wording", "context-equals"]);

  const explanation = mustRun([
    "workflow", "overlay", "explain",
    "--root", project,
    "--id", "review-wording",
    "--overlay-version", "1",
    "--locale", "en",
  ], project);
  const explanationPrimary = primaryText(explanation, "en");
  assert.match(explanationPrimary, /What this adjustment changes:/u);
  assert.match(explanationPrimary, /to move from “Peer Review” to “Approved”, Team Authorized must be yes/u);
  assert.match(explanationPrimary, /general information: Audience is set to “delivery team”/u);
  assertNoImplementationVocabulary(explanationPrimary, ["review-process", "review-wording", "context-equals"]);

  const tooLarge = run([
    "workflow", "overlay", "propose",
    "--root", project,
    "--id", "too-large-adjustment",
    "--overlay-version", "1",
    "--definition", "review-process",
    "--definition-version", "1",
    "--overlay-json", JSON.stringify({ metadata: { reviewers: Array.from({ length: 11 }, (_, index) => `Team ${index + 1}`) } }),
  ], project);
  assert.equal(tooLarge.status, 1);
  assert.match(tooLarge.stderr, /cannot be reviewed completely and readably/u);
  assert.equal(fs.existsSync(path.join(project, ".sdlc", "workflows", "overlays", "too-large-adjustment", "v1.json")), false);

  const secretLike = run([
    "workflow", "overlay", "propose",
    "--root", project,
    "--id", "secret-adjustment",
    "--overlay-version", "1",
    "--definition", "review-process",
    "--definition-version", "1",
    "--overlay-json", JSON.stringify({ metadata: { api_token: "must-not-appear" } }),
  ], project);
  assert.equal(secretLike.status, 1);
  assert.match(secretLike.stderr, /could hold a secret/u);
  assert.equal(secretLike.stderr.includes("must-not-appear"), false);
  assert.equal(fs.existsSync(path.join(project, ".sdlc", "workflows", "overlays", "secret-adjustment", "v1.json")), false);
});

test("custom process review is complete and rejects secrets, spoofing, and unreviewable content before persistence", () => {
  const project = temporaryProject("custom-definition");
  mustRun(["init", "--root", project, "--project-name", "Custom process review"], project);

  const validDefinition = {
    name: "Customer launch review",
    description: "A delivery lead confirms readiness before launch.",
    initial_state: "draft",
    states: [
      { id: "draft", label: "Draft", terminal: false, metadata: { audience: "delivery team" } },
      { id: "completed", label: "Completed", terminal: true, metadata: { retention_days: 30 } },
    ],
    transitions: [{
      id: "complete",
      from: "draft",
      to: "completed",
      label: "Confirm launch",
      guards: [{ id: "context-present", parameters: { key: "approval_note" } }],
      metadata: { owner: "review board" },
    }],
    phase_order: ["draft", "completed"],
    normal_checkpoints: ["launch-review"],
    metadata: { region: "Italy" },
  };

  const proposal = mustRun([
    "workflow", "definition", "propose",
    "--root", project,
    "--id", "customer-launch",
    "--definition-version", "1",
    "--definition-json", JSON.stringify(validDefinition),
    "--locale", "en",
  ], project);
  const proposalPrimary = primaryText(proposal, "en");
  assert.match(proposalPrimary, /Descriptive content to confirm:/u);
  assert.match(proposalPrimary, /displayed name: “Customer launch review”/u);
  assert.match(proposalPrimary, /purpose: “A delivery lead confirms readiness before launch\.”/u);
  assert.match(proposalPrimary, /general information: Region is set to “Italy”/u);
  assert.match(proposalPrimary, /information for the “Draft” step: Audience is set to “delivery team”/u);
  assert.match(proposalPrimary, /information for the route from “Draft” to “Completed”: Owner is set to “review board”/u);
  assertNoImplementationVocabulary(proposalPrimary, ["customer-launch", "context-present"]);

  const approval = mustRun([
    "workflow", "definition", "approve",
    "--root", project,
    "--id", "customer-launch",
    "--definition-version", "1",
    "--actor-type", "human",
    "--approval-source", "explicit-user",
    "--summary", "Confermo il processo e tutte le informazioni mostrate",
    "--locale", "it",
  ], project);
  const approvalPrimary = primaryText(approval, "it");
  assert.match(approvalPrimary, /Contenuto descrittivo:/u);
  assert.match(approvalPrimary, /nome mostrato: “Customer launch review”/u);
  assert.match(approvalPrimary, /informazioni generali: Area viene impostato su “Italy”/u);
  assert.match(approvalPrimary, /informazioni del passaggio “Completato”: Giorni di conservazione viene impostato su 30/u);
  assertNoImplementationVocabulary(approvalPrimary, ["customer-launch", "context-present"]);

  const branchedDefinition = {
    name: "Branched review",
    description: "Every available review path must be shown before approval.",
    initial_state: "draft",
    states: [
      { id: "draft", label: "Draft", terminal: false, metadata: {} },
      { id: "safe-review", label: "Safe review", terminal: false, metadata: {} },
      { id: "manual-review", label: "Manual review", terminal: false, metadata: {} },
      { id: "completed", label: "Completed", terminal: true, metadata: {} },
    ],
    transitions: [
      { id: "choose-safe", from: "draft", to: "safe-review", label: "Choose safe review", guards: [{ id: "always", parameters: {} }], metadata: {} },
      { id: "choose-manual", from: "draft", to: "manual-review", label: "Choose manual review", guards: [{ id: "always", parameters: {} }], metadata: {} },
      { id: "finish-safe", from: "safe-review", to: "completed", label: "Finish safe review", guards: [], metadata: {} },
      { id: "finish-manual", from: "manual-review", to: "completed", label: "Finish manual review", guards: [], metadata: {} },
    ],
    phase_order: [],
    normal_checkpoints: [],
    metadata: {},
  };
  const branched = mustRun([
    "workflow", "definition", "propose",
    "--root", project,
    "--id", "branched-review",
    "--definition-version", "1",
    "--definition-json", JSON.stringify(branchedDefinition),
    "--locale", "en",
  ], project);
  const branchedPrimary = primaryText(branched, "en");
  assert.match(branchedPrimary, /All steps: Draft \(starting\); Safe Review; Manual Review; Completed \(final\)\./u);
  assert.match(branchedPrimary, /Draft → Safe Review \(“Choose safe review”\): requires no additional condition/u);
  assert.match(branchedPrimary, /Draft → Manual Review \(“Choose manual review”\): requires no additional condition/u);
  assert.match(branchedPrimary, /Safe Review → Completed/u);
  assert.match(branchedPrimary, /Manual Review → Completed/u);

  const rejectedCases = [
    ["api-token", { metadata: { apiToken: "must-not-appear" } }],
    ["client-secret", { metadata: { clientSecret: "must-not-appear" } }],
    ["private-key", { metadata: { privateKey: "must-not-appear" } }],
    ["ansi", { description: "Safe\u001b[2Jspoofed" }],
    ["bidi", { description: "Safe\u202Espoofed" }],
    ["invisible", { metadata: { "review\u200Bowner": "team" } }],
    ["too-large", { metadata: { reviewers: Array.from({ length: 11 }, (_, index) => `Team ${index + 1}`) } }],
    ["unsafe-state-label", {
      states: validDefinition.states.map((state, index) => index === 0 ? { ...state, label: "Draft\u001b[2Jspoofed" } : state),
    }],
    ["secret-guard-key", {
      transitions: [{
        ...validDefinition.transitions[0],
        guards: [{ id: "context-equals", parameters: { key: "clientSecret", value: "must-not-appear" } }],
      }],
    }],
    ["unsafe-transition-label", {
      transitions: [{ ...validDefinition.transitions[0], label: "Confirm\u202Ehidden" }],
    }],
  ];
  for (const [suffix, patch] of rejectedCases) {
    const id = `unsafe-${suffix}`;
    const candidate = {
      ...validDefinition,
      ...patch,
      metadata: patch.metadata ?? validDefinition.metadata,
    };
    const result = run([
      "workflow", "definition", "propose",
      "--root", project,
      "--id", id,
      "--definition-version", "1",
      "--definition-json", JSON.stringify(candidate),
    ], project);
    assert.equal(result.status, 1, `${suffix}\n${result.stdout}\n${result.stderr}`);
    assert.equal(result.stdout.includes("must-not-appear"), false);
    assert.equal(result.stderr.includes("must-not-appear"), false);
    assert.equal(result.stdout.includes("\u001b"), false);
    assert.equal(result.stderr.includes("\u001b"), false);
    assert.equal(fs.existsSync(path.join(project, ".sdlc", "workflows", "definitions", id, "v1.json")), false);
  }
});
