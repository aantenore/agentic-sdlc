import assert from "node:assert/strict";
import test from "node:test";

import { buildHelpModel, renderHelp, UnknownCommandError } from "../../lib/cli/help.mjs";

const FORBIDDEN_PRIMARY_JARGON = /\b(?:bounded-autonomous|checkpointed|checkpoint|audit_only|host_verified|profile|receipt|ceiling|schema|hash)\b/iu;

test("root help explains practical behavior before technical details", () => {
  const output = renderHelp([], { locale: "en", version: "0.11.0" });
  const [primary, technical] = output.split("Technical details (optional):");
  assert.match(output, /^Outcome:/u);
  assert.match(primary, /Outcome:/u);
  assert.match(primary, /What this changes in practice:/u);
  assert.match(primary, /What you need to decide:/u);
  assert.match(primary, /What remains protected:/u);
  assert.match(primary, /Next step:/u);
  assert.match(primary, /Talk naturally to your coding agent about the outcome you want\./u);
  assert.doesNotMatch(primary, /Codex/u);
  assert.match(primary, /This CLI is for structured recovery and automation/u);
  assert.match(primary, /requirement -> story -> work brief\/output -> autonomy -> story workflow start -> one task start -> story claim -> complete each phase and advance -> validation gate -> enter release -> delivery\/release evidence -> final lifecycle gate/u);
  assert.doesNotMatch(primary, FORBIDDEN_PRIMARY_JARGON);
  assert.doesNotMatch(primary, /(?:agentic-sdlc|--[a-z])/iu);
  assert.match(technical, /Usage:/u);
  assert.match(technical, /\n  status\s+Show the current outcome/u);

  const italian = renderHelp([], { locale: "it" });
  const [italianPrimary] = italian.split("Dettagli tecnici (facoltativi):");
  assert.match(italianPrimary, /Parla naturalmente con il tuo agente di sviluppo del risultato che vuoi ottenere\./u);
  assert.doesNotMatch(italianPrimary, /Codex/u);
  assert.match(italianPrimary, /Questa CLI serve per recupero strutturato e automazione/u);
  assert.match(italianPrimary, /requisito -> story -> accordo di lavoro\/output -> autonomia -> avvio workflow della story -> un solo avvio attività -> assegnazione della story -> completa e avanza ogni fase -> gate di validazione -> ingresso in release -> consegna\/prove di release -> gate lifecycle finale/u);
});

test("Italian leaf help is understandable without plugin terminology", () => {
  const output = renderHelp(["autonomy", "delivery", "approve"], { locale: "it" });
  const [primary, technical] = output.split("Dettagli tecnici (facoltativi):");
  assert.match(output, /^Risultato:/u);
  assert.match(primary, /Risultato: Approva i limiti soltanto per questa consegna\./u);
  assert.match(primary, /Cosa cambia in pratica:/u);
  assert.match(primary, /Cosa devi decidere:/u);
  assert.match(primary, /Cosa resta protetto:/u);
  assert.match(primary, /Prossimo passo:/u);
  assert.doesNotMatch(primary, FORBIDDEN_PRIMARY_JARGON);
  assert.doesNotMatch(primary, /(?:agentic-sdlc|--[a-z])/iu);
  assert.match(technical, /agentic-sdlc autonomy delivery approve/u);
  assert.match(technical, /--authorization/u);
  assert.match(technical, /serve --summary oppure --approval-evidence/u);
  assert.doesNotMatch(technical, /requires --summary|required with|--summary or --approval-evidence/u);
});

test("delivery help exposes required runtime inputs rather than internal aliases", () => {
  const propose = renderHelp(["autonomy", "delivery", "propose"]);
  const [proposePrimary, proposeTechnical] = propose.split("Technical details (optional):");
  assert.match(proposePrimary, /Choose how independently I should work for this one exact delivery/u);
  assert.match(proposePrimary, /Pull requests and local releases always use separate choices/u);
  assert.doesNotMatch(proposePrimary, FORBIDDEN_PRIMARY_JARGON);
  for (const flag of ["--id", "--delivery", "--kind", "--story", "--contract", "--requirement", "--level"]) {
    assert.match(proposeTechnical, new RegExp(`${flag}[^\\n]*\\(required\\)`, "u"));
  }
  assert.doesNotMatch(proposeTechnical, /--contract-id/u);
  assert.match(proposeTechnical, /--repository[^\n]*required with --kind pull_request/u);
  assert.match(proposeTechnical, /--target-root[^\n]*required with --kind local_release/u);
  assert.match(
    proposeTechnical,
    /--target-root[\s\S]*may be absent while planning[\s\S]*before rollback\.verify, data\.migrate, data\.rollback, or release\.local[\s\S]*request build\.local authorization first[\s\S]*CLI never creates directories/u,
  );
  assert.match(proposeTechnical, /--smoke-cwd[^\n]*required when more than one --write-path is present/u);
  assert.match(proposeTechnical, /--pr-mode <new\|existing>/u);
  assert.match(proposeTechnical, /--pr-mode[^\n]*defaults to new/u);
  assert.match(proposeTechnical, /--pr-number[^\n]*required with --kind pull_request and --pr-mode existing/u);
  assert.match(proposeTechnical, /--pr-url[^\n]*required with --kind pull_request and --pr-mode existing/u);
  assert.match(proposeTechnical, /--pr-head-sha[^\n]*local head cannot supply it/u);
  assert.ok(proposeTechnical.includes(
    "--pr-mode existing --pr-number 184 --pr-url https://github.com/owner/repository/pull/184",
  ));
  assert.match(proposeTechnical, /supervised means Guided/u);
  assert.match(proposeTechnical, /checkpointed means Autonomy with checks/u);

  const italian = renderHelp(["autonomy", "delivery", "propose"], { locale: "it" });
  const [italianPrimary] = italian.split("Dettagli tecnici (facoltativi):");
  assert.match(italianPrimary, /Scegli quanta autonomia devo avere per questa singola consegna esatta/u);
  assert.match(italianPrimary, /Pull request e rilasci locali usano sempre scelte separate/u);

  const action = buildHelpModel(["autonomy", "delivery", "action"]);
  const flags = new Map(action.options.map((entry) => [entry.flag, entry]));
  assert.equal(flags.get("--id").required, true);
  assert.equal(flags.get("--action").required, true);
  assert.equal(flags.has("--outcome"), true);
  assert.equal(flags.has("--evidence"), true);
  assert.match(
    action.human.result,
    /new local destination.*request build\.local first without confirmation.*only if it reports checkpoint_required.*repeat with direct approval.*external builder creates the exact approved root.*completed with evidence.*rollback\.verify, data\.migrate, data\.rollback, or release\.local/iu,
  );
  assert.equal(
    action.examples.filter((example) => /--action build\.local/u.test(example))[0],
    "agentic-sdlc autonomy delivery action --id AUT-LOCAL-009 --action build.local",
  );
  assert.equal(
    action.examples.some((example) =>
      /--action build\.local --confirm-action.*exact approved local target/u.test(example)),
    true,
  );
  assert.equal(
    action.examples.some((example) =>
      /--action build\.local --outcome passed.*--authorization-receipt.*--evidence/u.test(example)),
    true,
  );
});

test("trace append help includes a runnable example and its operational flags", () => {
  const model = buildHelpModel(["trace", "append"]);
  const flags = new Map(model.options.map((entry) => [entry.flag, entry]));
  assert.equal(flags.get("--type")?.required, true);
  assert.equal(flags.get("--summary")?.required, true);
  for (const flag of ["--evidence", "--outcome", "--action", "--related", "--actor-type"]) {
    assert.equal(flags.has(flag), true, flag);
  }
  assert.equal(model.examples.length, 1);
  assert.match(model.examples[0], /^agentic-sdlc trace append --type decision --summary/u);
});

test("requirement and contract help include safe runnable examples and exact runtime flags", () => {
  const requirement = buildHelpModel(["requirement", "propose"]);
  const requirementFlags = new Map(requirement.options.map((entry) => [entry.flag, entry]));
  for (const flag of ["--id", "--title", "--acceptance", "--autonomy-ceiling"]) {
    assert.equal(requirementFlags.get(flag)?.required, true, flag);
  }
  assert.equal(requirement.examples.length, 1);
  assert.match(requirement.examples[0], /--title .*--summary .*--acceptance .*--autonomy-ceiling/u);
  assert.match(requirement.examples[0], /--write-path src .*--write-path test .*--write-path docs .*--write-path evidence/u);
  assert.match(requirementFlags.get("--write-path")?.description, /stored Git-relative/u);

  const revision = buildHelpModel(["requirement", "revise"]);
  const revisionFlags = new Map(revision.options.map((entry) => [entry.flag, entry]));
  assert.equal(revisionFlags.get("--id")?.required, true);
  assert.equal(revisionFlags.get("--new-id")?.required, true);
  assert.equal(revisionFlags.get("--write-path")?.repeatable, true);
  assert.match(revision.human.result, /inherited unless an explicit replacement/iu);
  assert.match(revision.examples[0], /--new-id .*--write-path src .*--write-path test/u);

  const italianRevision = buildHelpModel(["requirement", "revise"], { locale: "it" });
  assert.match(italianRevision.human.result, /vengono ereditate.*elenco sostitutivo/iu);
  assert.match(
    italianRevision.options.find((entry) => entry.flag === "--write-path")?.description,
    /salvati relativi a Git.*rilascio locale.*destinazione assoluta/iu,
  );

  const supersede = buildHelpModel(["requirement", "supersede"]);
  const supersedeFlags = new Map(supersede.options.map((entry) => [entry.flag, entry]));
  for (const flag of ["--id", "--new-id", "--reason", "--actor-type"]) {
    assert.equal(supersedeFlags.get(flag)?.required, true, flag);
  }
  assert.match(supersedeFlags.get("--approval-source")?.required_when, /not supplied by CI/u);
  for (const flag of ["--actor-name", "--actor-email"]) {
    assert.equal(supersedeFlags.has(flag), true, flag);
  }
  for (const flag of ["--summary", "--approval-evidence"]) {
    assert.match(supersedeFlags.get(flag)?.required_when, /explicit-user, automation, or bootstrap/u, flag);
    assert.match(supersedeFlags.get(flag)?.required_one_of, /--summary or --approval-evidence/u, flag);
  }
  assert.match(supersedeFlags.get("--authorization")?.required_when, /--approval-source automation/u);
  assert.match(supersedeFlags.get("--host-receipt-file")?.required_when, /trusted host or CI proof/u);
  assert.match(
    supersede.usage,
    /^agentic-sdlc requirement supersede --id <current-id> --new-id <approved-direct-revision-id>/u,
  );
  assert.equal(supersede.examples.length, 1);
  assert.doesNotMatch(supersede.examples[0], /<[^>]+>/u);
  assert.match(
    supersede.examples[0],
    /^agentic-sdlc requirement supersede --id REQ-BOOKING-001 --new-id REQ-BOOKING-002 --reason/u,
  );

  const italianSupersede = buildHelpModel(["requirement", "supersede"], { locale: "it" });
  const italianSupersedeFlags = new Map(italianSupersede.options.map((entry) => [entry.flag, entry]));
  assert.match(italianSupersedeFlags.get("--approval-source")?.required_when, /non è indicato dalla CI/u);
  assert.match(
    italianSupersedeFlags.get("--approval-evidence")?.required_one_of,
    /--summary oppure --approval-evidence/u,
  );

  const approve = buildHelpModel(["requirement", "approve"]);
  assert.match(approve.examples[0], /--actor-type human --approval-source explicit-user --summary/u);

  const contract = buildHelpModel(["contract", "create"]);
  const contractFlags = new Map(contract.options.map((entry) => [entry.flag, entry]));
  assert.equal(contractFlags.get("--phase")?.required, true);
  assert.equal(contractFlags.has("--delivery-profile"), true);
  assert.equal(contractFlags.has("--profile"), false);
  assert.match(contract.examples[0], /--phase design --context-summary .*--validation/u);

  const italianContract = buildHelpModel(["contract", "create"], { locale: "it" });
  const italianFlags = new Map(italianContract.options.map((entry) => [entry.flag, entry]));
  assert.match(italianFlags.get("--delivery-profile").required_when, /una story di implementazione/u);
  assert.match(italianFlags.get("--context-summary").required_one_of, /una tra --context-summary/u);
  assert.match(italianFlags.get("--output-ref").required_when, /risultato persistente/u);
  assert.doesNotMatch(italianFlags.get("--delivery-profile").required_when, /implementation|approved|enforcement/u);
});

test("core work commands keep human guidance plain and runtime flags in optional details", () => {
  const expectations = [
    { path: ["story", "create"], flags: ["--title", "--acceptance"] },
    { path: ["story", "acceptance", "add"], flags: ["--id", "--acceptance", "--summary"] },
    { path: ["story", "claim"], flags: ["--agent", "--branch"] },
    { path: ["output", "resolve"], flags: ["--story", "--type"] },
    { path: ["contract", "approve"], flags: ["--actor-type", "--approval-source", "--approval-evidence"] },
    { path: ["task", "start"], flags: ["--intent-json", "--intent-file", "--contract-id", "--confirm-start"] },
  ];

  for (const expectation of expectations) {
    const output = renderHelp(expectation.path, { locale: "it" });
    const [primary, technical] = output.split("Dettagli tecnici (facoltativi):");
    assert.doesNotMatch(primary, FORBIDDEN_PRIMARY_JARGON, expectation.path.join(" "));
    assert.doesNotMatch(primary, /(?:agentic-sdlc|--[a-z])/iu, expectation.path.join(" "));
    for (const flag of expectation.flags) {
      assert.match(technical, new RegExp(flag, "u"), `${expectation.path.join(" ")} should expose ${flag}`);
    }
  }

  const claimEnglish = renderHelp(["story", "claim"], { locale: "en" });
  assert.match(
    claimEnglish.split("Technical details (optional):")[0],
    /started story.*observable acceptance criteria.*current approved contract/is,
  );
  const claimItalian = renderHelp(["story", "claim"], { locale: "it" });
  assert.match(
    claimItalian.split("Dettagli tecnici (facoltativi):")[0],
    /story già avviata.*criteri di successo osservabili.*contratto corrente approvato/is,
  );
  const acceptanceEnglish = renderHelp(["story", "acceptance", "add"], { locale: "en" });
  assert.match(
    acceptanceEnglish.split("Technical details (optional):")[0],
    /if a contract already exists.*replace and approve it.*start the revised work before claiming/is,
  );
  const startItalian = renderHelp(["task", "start"], { locale: "it" });
  assert.match(
    startItalian.split("Dettagli tecnici (facoltativi):")[0],
    /un avvio riuscito abilita l’assegnazione della story/is,
  );
});

test("first-project lifecycle help exposes the exact assessment, evidence, and gate inputs", () => {
  const describe = (command) => buildHelpModel(command.split(" "));
  const flags = (command) => new Map(describe(command).options.map((entry) => [entry.flag, entry]));

  const prepare = flags("assessment proposal prepare");
  for (const flag of [
    "--id",
    "--baseline",
    "--story",
    "--requirement",
    "--scope-title",
    "--scope-summary",
    "--type",
    "--template",
    "--section",
    "--acceptance",
    "--artifact",
    "--capability",
    "--budget-json",
    "--budget-file",
    "--force",
  ]) {
    assert.equal(prepare.has(flag), true, `assessment proposal prepare should expose ${flag}`);
  }

  const approve = flags("assessment proposal approve");
  assert.equal(approve.get("--id")?.required, true);
  assert.equal(approve.get("--actor-type")?.required, true);
  assert.equal(approve.get("--actor-type")?.value, "human|ci");
  assert.match(approve.get("--approval-source")?.required_when, /not supplied by CI/u);
  assert.equal(approve.get("--approval-source")?.value, "explicit-user|ci");
  assert.equal(approve.get("--summary")?.required_one_of, "--summary or --approval-evidence");
  assert.equal(approve.has("--host-receipt-file"), true);

  const complete = flags("story complete-step");
  assert.equal(complete.get("--id")?.required, true);
  assert.equal(complete.get("--step")?.required, true);
  assert.equal(complete.get("--step")?.value, "configured-step");
  assert.match(complete.get("--step")?.description || "", /project's phase_order/u);
  assert.equal(
    complete.get("--summary")?.required_one_of,
    "one of --summary, --type, --artifact, or --evidence",
  );
  for (const flag of ["--type", "--artifact", "--evidence", "--next-step", "--release-claim", "--allow-unapproved-contract-output"]) {
    assert.equal(complete.has(flag), true, `story complete-step should expose ${flag}`);
  }
  assert.match(complete.get("--authorization")?.required_when, /story\.complete-step/u);
  assert.match(
    complete.get("--authorization")?.description || "",
    /otherwise automatic completion.*validated and consumed/iu,
  );

  const taskStart = flags("task start");
  for (const flag of ["--actor", "--actor-type", "--actor-name", "--actor-email"]) {
    assert.equal(taskStart.has(flag), true, `task start should expose ${flag}`);
  }

  const link = flags("output link");
  for (const flag of ["--story", "--type", "--artifact", "--template", "--mode"]) {
    assert.equal(link.get(flag)?.required, true, `output link ${flag} should be marked required`);
  }
  for (const flag of ["--base-artifact", "--requirement", "--evidence", "--receipt-file", "--authorization", "--decision-id", "--rationale"]) {
    assert.equal(link.has(flag), true, `output link should expose ${flag}`);
  }
  const linkHelp = describe("output link");
  assert.match(linkHelp.human.result, /render or visual verification evidence/u);
  assert.doesNotMatch(linkHelp.examples[0], /--evidence/u);

  const gate = flags("gate check");
  for (const flag of ["--story", "--scope", "--release-manifest", "--strict", "--lifecycle-complete", "--out", "--force"]) {
    assert.equal(gate.has(flag), true, `gate check should expose ${flag}`);
  }
  assert.match(gate.get("--release-manifest")?.required_when, /scope release-manifest/u);
  assert.equal(gate.get("--lifecycle-complete")?.value, null);
  assert.match(gate.get("--lifecycle-complete")?.description, /terminal delivery/u);

  for (const command of [
    "assessment proposal prepare",
    "assessment proposal approve",
    "story complete-step",
    "output link",
    "gate check",
  ]) {
    const model = describe(command);
    assert.match(model.usage, new RegExp(`^agentic-sdlc ${command}`, "u"), command);
    assert.equal(model.examples.length > 0, true, `${command} should include a useful example`);
    assert.doesNotMatch(model.examples[0], /<[^>]+>/u, `${command} example should not contain placeholders`);
  }
});

test("optimization and budget focused help expose executable and metering boundaries", () => {
  const describe = (command) => buildHelpModel(command.split(" "));
  const flags = (command) => new Map(describe(command).options.map((entry) => [entry.flag, entry]));

  const run = flags("optimization run");
  assert.equal(run.get("--command-json")?.required, true);
  assert.match(run.get("--proposal")?.required_when, /governed assessment/u);
  for (const flag of ["--profile", "--exact", "--trust-custom-rtk-command"]) {
    assert.equal(run.has(flag), true, `optimization run should expose ${flag}`);
  }
  assert.match(run.get("--json")?.description, /Not supported.*child output is streamed/u);

  const usage = flags("budget usage record");
  assert.equal(usage.get("--proposal")?.required, true);
  for (const flag of [
    "--receipt-json",
    "--receipt-file",
    "--active-time-seconds",
    "--steps",
    "--model-calls",
    "--tool-calls",
    "--input-tokens",
    "--output-tokens",
    "--cost-amount",
    "--currency",
    "--metering-accuracy",
    "--metering-source",
    "--pricing-ref",
    "--subagent",
  ]) {
    assert.equal(usage.has(flag), true, `budget usage record should expose ${flag}`);
  }

  for (const command of ["budget meter start", "budget meter record", "budget amend", "budget status"]) {
    assert.equal(flags(command).get("--proposal")?.required, true, `${command} should require --proposal`);
  }
  assert.equal(flags("budget meter record").has("--baseline"), true);
  assert.equal(flags("budget meter record").has("--thread-id"), true);
  assert.equal(flags("budget amend").get("--budget-json")?.required_one_of, "--budget-json or --budget-file");
  assert.equal(flags("budget amend").get("--reason")?.required_one_of, "--reason or --summary");

  for (const command of [
    "optimization run",
    "budget usage record",
    "budget meter start",
    "budget meter record",
    "budget amend",
    "budget status",
  ]) {
    const model = describe(command);
    assert.match(model.usage, new RegExp(`^agentic-sdlc ${command}`, "u"), command);
    assert.equal(model.examples.length > 0, true, `${command} should include a useful example`);
    assert.doesNotMatch(model.examples[0], /<[^>]+>/u, `${command} example should not contain placeholders`);
  }
});

test("recovery and automation help mirrors mandatory and conditional runtime inputs", () => {
  const describe = (command) => new Map(buildHelpModel(command.split(" ")).options.map((entry) => [entry.flag, entry]));
  const expectedFlags = {
    init: ["--project-name", "--project-id", "--force"],
    "onboard existing-project": ["--project-name", "--project-id", "--id", "--document", "--source", "--question", "--assumption", "--summary", "--confirmed-source", "--force"],
    "baseline propose": ["--id", "--document", "--source", "--question", "--assumption", "--summary", "--confirmed-source", "--force"],
    "output template propose": ["--type", "--id", "--from", "--body", "--preset", "--summary", "--format", "--delivery", "--extension", "--media-type", "--generator", "--force"],
    "capability profile propose": ["--id", "--story", "--requirement", "--phase", "--scope", "--context-file", "--constraint", "--confidence", "--profile-json", "--profile-file", "--force"],
    "capability recommend": ["--id", "--profile", "--recommendation-json", "--recommendation-file", "--available-capabilities-json", "--available-capabilities-file", "--force"],
    "task start": ["--intent-json", "--intent-file", "--text", "--story", "--phase", "--contract-id", "--delivery-profile", "--confirm-start", "--actor-type", "--authorization", "--revise-contract"],
  };

  for (const [command, flags] of Object.entries(expectedFlags)) {
    const options = describe(command);
    for (const flag of flags) assert.equal(options.has(flag), true, `${command} should expose ${flag}`);
    const model = buildHelpModel(command.split(" "));
    assert.equal(model.examples.length > 0, true, `${command} should include a copyable example`);
    assert.doesNotMatch(model.examples[0], /<[^>]+>/u, `${command} example should not contain placeholders`);
  }

  assert.equal(describe("output template propose").get("--type").required, true);
  assert.equal(describe("capability profile propose").get("--id").required, true);
  assert.equal(describe("capability recommend").get("--profile").required, true);
  assert.equal(describe("task start").get("--intent-json").required_one_of, "--intent-json or --intent-file");
  assert.match(describe("task start").get("--delivery-profile").required_when, /implementation, validation, or release/u);
});

test("approval, authorization, routing, and contract help expose governed runtime choices", () => {
  const describe = (command) => new Map(buildHelpModel(command.split(" ")).options.map((entry) => [entry.flag, entry]));
  const approvals = ["baseline approve", "output template approve", "capability profile approve", "capability approve", "contract approve"];

  for (const command of approvals) {
    const options = describe(command);
    assert.equal(options.get("--id")?.required, true, command);
    if (command === "contract approve") {
      assert.match(options.get("--actor-type")?.required_when, /--standing-approval is not used/u, command);
    } else {
      assert.equal(options.get("--actor-type")?.required, true, command);
    }
    assert.match(options.get("--approval-source")?.required_when, /not supplied by CI/u, command);
    assert.equal(options.get("--summary")?.required_one_of, "--summary or --approval-evidence", command);
    assert.match(options.get("--authorization")?.required_when, /automation/u, command);
    assert.equal(buildHelpModel(command.split(" ")).examples.length > 0, true, command);
  }

  const authorization = describe("authorization grant");
  for (const flag of ["--id", "--scope", "--summary", "--actor-type", "--approval-source"]) {
    assert.equal(authorization.get(flag)?.required, true, flag);
  }
  assert.equal(authorization.get("--allow-action")?.required_one_of, "--allow-action or --allow-use");
  assert.equal(authorization.get("--allow-use")?.required_one_of, "--allow-action or --allow-use");
  for (const flag of ["--allow-subject", "--allow-artifact-type", "--allow-boundary", "--expires-at", "--proposal", "--proposal-hash", "--max-uses", "--authority-assurance", "--approval-evidence", "--force"]) {
    assert.equal(authorization.has(flag), true, flag);
  }

  const route = describe("route decide");
  assert.equal(route.get("--intent-json")?.required_one_of, "--intent-json or --intent-file");
  assert.equal(route.get("--intent-file")?.required_one_of, "--intent-json or --intent-file");
  assert.match(buildHelpModel(["route", "decide"]).human.result, /project routing configuration/u);
  assert.match(buildHelpModel(["route", "decide"]).examples[0], /"requested_action":"implement_story"/u);

  const contract = describe("contract create");
  assert.equal(contract.get("--phase")?.value, "configured-phase");
  assert.match(contract.get("--phase")?.description || "", /project's phase_order/u);
  assert.equal(describe("init").has("--template-dir"), true);
  assert.equal(describe("onboard existing-project").has("--template-dir"), true);
  assert.equal(contract.get("--reasoning")?.value, "inherit|minimal|low|medium|high");
  assert.equal(contract.has("--force"), true);
  assert.equal(describe("contract approve").get("--status")?.value, "approved|changes_requested|rejected");
  assert.equal(describe("output template propose").get("--format")?.value, "markdown|docx|xlsx|pdf|pptx|html|json|csv|custom");
  assert.equal(describe("authorization grant").get("--authority-assurance")?.value, "audit_only|host_verified");
});

test("hierarchical help shows only the selected group's immediate children", () => {
  const model = buildHelpModel(["autonomy", "delivery"], { locale: "en" });
  assert.equal(Object.isFrozen(model), true);
  assert.equal(Object.isFrozen(model.commands[0]), true);
  assert.equal(model.command.kind, "group");
  assert.deepEqual(model.commands.map((entry) => entry.name), ["action", "approve", "close", "explain", "propose", "revoke", "status"]);
  assert.equal(model.commands.some((entry) => entry.path === "requirement approve"), false);
});

test("JSON help is stable and keeps human guidance structured", () => {
  const first = renderHelp(["status"], { locale: "it", json: true, version: "0.11.0" });
  const second = renderHelp("help status", { locale: "it", json: true, version: "0.11.0" });
  assert.equal(first, second);
  const parsed = JSON.parse(first);
  assert.equal(parsed.schema_version, "agentic-sdlc-help-v1");
  assert.equal(parsed.locale, "it");
  assert.equal(parsed.command.path, "status");
  assert.match(parsed.human.next_action, /Controlla/u);
});

test("unknown help path returns bounded nearest suggestions", () => {
  assert.throws(
    () => renderHelp(["autonomy", "delivry", "aproove"]),
    (error) => {
      assert.equal(error instanceof UnknownCommandError, true);
      assert.equal(error.code, "UNKNOWN_COMMAND");
      assert.equal(error.suggestions[0], "autonomy delivery approve");
      assert.equal(error.suggestions.length, 3);
      const [primary, technical] = error.message.split("Technical details (optional):");
      assert.match(primary, /Outcome: I could not find the requested action\./u);
      assert.doesNotMatch(primary, /autonomy|delivry|aproove/u);
      assert.match(technical, /unknown_path: autonomy delivry aproove/u);
      return true;
    },
  );
});

test("unsupported locale fails before rendering", () => {
  assert.throws(() => renderHelp([], { locale: "fr" }), /Use en or it/u);
});
