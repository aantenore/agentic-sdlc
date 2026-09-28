import assert from "node:assert/strict";
import test from "node:test";

import {
  COMMAND_CATALOG,
  findCommand,
  getChildCommands,
  listCommandPaths,
  listOptions,
  suggestCommand,
} from "../../lib/cli/command-catalog.mjs";

test("command catalog is immutable and supports root, group, and leaf lookup", () => {
  assert.equal(Object.isFrozen(COMMAND_CATALOG), true);
  assert.equal(Object.isFrozen(COMMAND_CATALOG.children), true);
  assert.equal(findCommand([]), COMMAND_CATALOG);

  const group = findCommand(["autonomy", "delivery"]);
  assert.equal(group.kind, "group");
  assert.equal(group.description.it.includes("consegna"), true);
  assert.equal(Object.isFrozen(group), true);

  const leaf = findCommand("autonomy delivery approve");
  assert.equal(leaf.kind, "command");
  assert.deepEqual(leaf.path, ["autonomy", "delivery", "approve"]);
  assert.equal(leaf.effect, "protected");
  assert.equal(findCommand("agentic-sdlc autonomy delivery approve"), leaf);
  assert.equal(findCommand("autonomy delivery missing"), null);
});

test("catalog covers the dispatch families and the self-service commands", () => {
  const paths = new Set(listCommandPaths());
  const expected = [
    "help",
    "completion",
    "preset list",
    "preset show",
    "preset export",
    "observe",
    "portfolio status",
    "config status",
    "config migrate",
    "init",
    "doctor",
    "optimization run",
    "baseline approve",
    "assessment proposal prepare",
    "budget meter record",
    "requirement propose",
    "requirement approve",
    "requirement supersede",
    "autonomy requirement status",
    "autonomy delivery approve",
    "contract create",
    "story acceptance add",
    "story handoff close",
    "work item create",
    "breakdown policy set",
    "dependency approve",
    "capability profile approve",
    "approval requests",
    "authorization grant",
    "task start",
    "phase lock",
    "trace append",
    "sync record",
    "output template propose",
    "cache rebuild",
    "manifest rebuild",
    "archive closed",
    "migration identity",
    "report activity",
    "index rebuild",
    "kb search",
    "gate check",
    "orchestrate plan",
    "route decide",
    "status",
  ];
  for (const path of expected) assert.equal(paths.has(path), true, `missing catalog path: ${path}`);
  assert.equal(paths.size >= 100, true);
});

test("child and option discovery is deterministic and does not expose mutable arrays", () => {
  const children = getChildCommands("autonomy delivery");
  assert.deepEqual(children.map((entry) => entry.name), ["action", "approve", "close", "explain", "propose", "revoke", "status"]);
  assert.equal(Object.isFrozen(children), true);

  const options = listOptions("autonomy delivery approve");
  assert.equal(options.some((entry) => entry.flag === "--locale"), true);
  assert.equal(options.some((entry) => entry.flag === "--authorization"), true);
  assert.equal(new Set(options.map((entry) => entry.name)).size, options.length);
  assert.equal(Object.isFrozen(options), true);

  const configOptions = new Map(
    listOptions("config migrate", { includeGlobal: false })
      .map((entry) => [entry.flag, entry]),
  );
  assert.deepEqual(
    configOptions.get("--autonomy-mode")?.values,
    ["enforce_all", "enforce_new_only", "observe", "off"],
  );
  assert.equal(configOptions.has("--apply"), true);
  assert.equal(configOptions.has("--plan-hash"), true);
});

test("delivery self-service help mirrors the runtime flags and marks the main required inputs", () => {
  const describe = (command) => new Map(listOptions(command, { includeGlobal: false }).map((entry) => [entry.flag, entry]));

  const propose = describe("autonomy delivery propose");
  for (const flag of ["--id", "--delivery", "--kind", "--story", "--contract", "--requirement", "--level"]) {
    assert.equal(propose.get(flag)?.required, true, `${flag} should be marked required`);
  }
  for (const flag of ["--repository", "--base", "--head", "--write-path", "--allow-action", "--merge-allowed", "--target-root", "--smoke-cwd", "--smoke-test", "--rollback"]) {
    assert.equal(propose.has(flag), true, `missing runtime proposal flag: ${flag}`);
  }
  assert.equal(propose.has("--contract-id"), false);

  const approve = describe("autonomy delivery approve");
  for (const flag of ["--id", "--actor-type", "--approval-source"]) {
    assert.equal(approve.get(flag)?.required, true, `${flag} should be marked required`);
  }
  for (const flag of ["--summary", "--approval-evidence", "--authorization", "--host-receipt-file"]) {
    assert.equal(approve.has(flag), true, `missing runtime approval flag: ${flag}`);
  }

  const action = describe("autonomy delivery action");
  assert.equal(action.get("--id")?.required, true);
  assert.equal(action.get("--action")?.required, true);
  for (const flag of ["--scope-path", "--remote", "--pr-url", "--confirm-action", "--actor-type", "--approval-source", "--outcome", "--authorization-receipt", "--evidence", "--smoke-cwd", "--smoke-test", "--rollback"]) {
    assert.equal(action.has(flag), true, `missing runtime action flag: ${flag}`);
  }

  const trace = describe("trace append");
  assert.equal(trace.get("--type")?.required, true);
  assert.equal(trace.get("--summary")?.required, true);
  for (const flag of ["--evidence", "--outcome", "--action", "--related", "--actor-type"]) {
    assert.equal(trace.has(flag), true, `missing runtime trace flag: ${flag}`);
  }

  const localDataExample = findCommand("autonomy delivery propose").examples
    .find((example) => example.includes("AUT-DATA-009"));
  assert.match(localDataExample, /--write-path \/absolute\/local-data\/app/u);
  assert.match(localDataExample, /--write-path \/absolute\/local-data\/data/u);
  assert.match(localDataExample, /--smoke-cwd \/absolute\/local-data\/app/u);
});

test("requirement and contract help expose the runtime-required and conditional inputs", () => {
  const describe = (command) => new Map(listOptions(command, { includeGlobal: false }).map((entry) => [entry.flag, entry]));

  const requirement = describe("requirement propose");
  for (const flag of ["--id", "--title", "--acceptance", "--autonomy-ceiling"]) {
    assert.equal(requirement.get(flag)?.required, true, `${flag} should be marked required`);
  }
  assert.equal(requirement.get("--summary")?.required_one_of.en, "--summary or --scope-summary");
  assert.equal(requirement.get("--summary")?.required_one_of.it, "--summary oppure --scope-summary");
  assert.equal(requirement.get("--scope-summary")?.required_one_of.en, "--summary or --scope-summary");
  assert.match(requirement.get("--proposal")?.required_when.en, /proposal-hash/u);
  assert.match(requirement.get("--proposal")?.required_when.it, /fornito anche --proposal-hash/u);
  assert.match(requirement.get("--proposal-hash")?.required_when.en, /proposal/u);
  assert.match(requirement.get("--write-path")?.description.en, /stored Git-relative/u);
  assert.match(requirement.get("--write-path")?.description.en, /local release.*absolute destination/iu);
  assert.match(requirement.get("--write-path")?.description.it, /salvati relativi a Git/u);
  assert.match(requirement.get("--write-path")?.description.it, /rilascio locale.*destinazione assoluta/iu);

  const revision = describe("requirement revise");
  assert.equal(revision.get("--id")?.required, true);
  assert.equal(revision.get("--new-id")?.required, true);
  for (const flag of [
    "--title",
    "--summary",
    "--scope-summary",
    "--acceptance",
    "--autonomy-ceiling",
    "--source",
    "--non-goal",
    "--constraint",
    "--nfr",
    "--integration",
    "--tool",
    "--capability",
    "--environment",
    "--write-path",
    "--expires-at",
  ]) {
    assert.equal(revision.has(flag), true, `requirement revise should expose ${flag}`);
  }
  assert.match(findCommand("requirement revise").description.en, /inherited unless an explicit replacement/iu);
  assert.match(findCommand("requirement revise").description.it, /vengono ereditate.*elenco sostitutivo/iu);

  const supersession = describe("requirement supersede");
  for (const flag of ["--id", "--new-id", "--reason", "--actor-type"]) {
    assert.equal(supersession.get(flag)?.required, true, `${flag} should be marked required`);
  }
  assert.match(supersession.get("--approval-source")?.required_when.en, /not supplied by CI/u);
  assert.match(supersession.get("--approval-source")?.required_when.it, /non è indicato dalla CI/u);
  for (const flag of ["--actor-name", "--actor-email"]) {
    assert.equal(supersession.has(flag), true, `requirement supersede should expose ${flag}`);
  }
  for (const flag of ["--summary", "--approval-evidence"]) {
    assert.match(supersession.get(flag)?.required_when.en, /explicit-user, automation, or bootstrap/u, flag);
    assert.match(supersession.get(flag)?.required_one_of.en, /--summary or --approval-evidence/u, flag);
    assert.match(supersession.get(flag)?.required_one_of.it, /--summary oppure --approval-evidence/u, flag);
  }
  assert.match(supersession.get("--authorization")?.required_when.en, /--approval-source automation/u);
  assert.match(supersession.get("--host-receipt-file")?.required_when.en, /trusted host or CI proof/u);
  const supersedeCommand = findCommand("requirement supersede");
  assert.match(
    supersedeCommand.usage,
    /^requirement supersede --id <current-id> --new-id <approved-direct-revision-id> --reason <reason>/u,
  );
  assert.match(supersedeCommand.usage, /--actor-type <human\|ci\|agent\|system>/u);
  assert.match(supersedeCommand.usage, /\(--summary <decision> \| --approval-evidence <path>\)$/u);
  assert.equal(supersedeCommand.examples.length, 1);
  assert.doesNotMatch(supersedeCommand.examples[0], /<[^>]+>/u);
  for (const flag of ["--id", "--new-id", "--reason", "--actor-type", "--approval-source", "--summary"]) {
    assert.match(supersedeCommand.examples[0], new RegExp(flag, "u"), `example should include ${flag}`);
  }

  const approval = describe("requirement approve");
  assert.equal(approval.get("--id")?.required, true);
  assert.equal(approval.get("--actor-type")?.required, true);
  assert.match(approval.get("--approval-source")?.required_when.en, /CI/u);
  assert.match(approval.get("--approval-source")?.required_when.it, /indicato dalla CI/u);
  assert.match(approval.get("--authorization")?.required_when.en, /automation/u);
  assert.match(approval.get("--host-receipt-file")?.required_when.en, /trusted host/u);

  const contract = describe("contract create");
  assert.equal(contract.get("--phase")?.required, true);
  assert.equal(contract.has("--delivery-profile"), true);
  assert.equal(contract.has("--profile"), false);
  assert.match(contract.get("--delivery-profile")?.required_when.en, /implementation, validation, or release/u);
  assert.match(contract.get("--delivery-profile")?.required_when.it, /story di implementazione/u);
  assert.match(contract.get("--output-ref")?.required_when.en, /durable output/u);
  for (const flag of ["--context-summary", "--context-file", "--qa", "--capability-recommendation"]) {
    assert.match(contract.get(flag)?.required_one_of.en, /one of --context-summary/u, flag);
    assert.match(contract.get(flag)?.required_one_of.it, /una tra --context-summary/u, flag);
  }
});

test("focused lifecycle help mirrors the runtime inputs needed to create and start work", () => {
  const describe = (command) => new Map(listOptions(command, { includeGlobal: false }).map((entry) => [entry.flag, entry]));

  const storyCreate = describe("story create");
  assert.equal(storyCreate.get("--id")?.required, true);
  assert.equal(storyCreate.get("--title")?.required, true);
  assert.equal(storyCreate.get("--acceptance")?.repeatable, true);
  assert.match(storyCreate.get("--acceptance")?.required_when?.en, /status ready/u);
  assert.match(storyCreate.get("--acceptance")?.required_when?.en, /draft may add it later/u);
  assert.equal(storyCreate.has("--template-dir"), true);

  const acceptanceAdd = describe("story acceptance add");
  assert.equal(acceptanceAdd.get("--id")?.required, true);
  assert.equal(acceptanceAdd.get("--acceptance")?.required, true);
  assert.equal(acceptanceAdd.get("--acceptance")?.repeatable, true);
  assert.equal(acceptanceAdd.has("--summary"), true);

  const storyClaim = describe("story claim");
  assert.equal(storyClaim.get("--id")?.required, true);
  assert.equal(storyClaim.get("--agent")?.required, true);
  assert.equal(storyClaim.has("--branch"), true);
  assert.match(storyClaim.get("--authorization")?.required_when?.en, /story\.claim/u);
  assert.match(
    findCommand("story claim").description.en,
    /started story.*current approved contract/is,
  );
  assert.match(
    findCommand("story claim").description.it,
    /story già avviata.*contratto corrente approvato/is,
  );
  assert.match(
    findCommand("story acceptance add").description.en,
    /replace and approve it.*start the revised work before claiming/is,
  );
  assert.match(
    findCommand("task start").description.it,
    /avvio riuscito abilita l’assegnazione della story/is,
  );

  const outputResolve = describe("output resolve");
  assert.equal(outputResolve.get("--story")?.required, true);
  assert.equal(outputResolve.get("--type")?.required, true);

  const contractApprove = describe("contract approve");
  assert.equal(contractApprove.get("--id")?.required, true);
  assert.equal(contractApprove.get("--actor-type")?.required, true);
  assert.match(contractApprove.get("--approval-source")?.required_when.en, /not supplied by CI/u);
  for (const flag of ["--actor-name", "--actor-email", "--summary", "--approval-evidence", "--authorization", "--host-receipt-file"]) {
    assert.equal(contractApprove.has(flag), true, `missing contract approval flag: ${flag}`);
  }
  assert.equal(contractApprove.get("--summary")?.required_one_of.en, "--summary or --approval-evidence");

  const taskStart = describe("task start");
  for (const flag of [
    "--intent-json",
    "--intent-file",
    "--text",
    "--story",
    "--phase",
    "--contract-id",
    "--delivery-profile",
    "--confirm-start",
    "--actor-type",
    "--authorization",
    "--revise-contract",
  ]) {
    assert.equal(taskStart.has(flag), true, `missing task-start flag: ${flag}`);
  }
  assert.equal(taskStart.has("--contract"), false);
  assert.equal(taskStart.get("--intent-json")?.required_one_of.en, "--intent-json or --intent-file");
  assert.equal(taskStart.get("--intent-file")?.required_one_of.it, "--intent-json oppure --intent-file");
});

test("capability selectors use --profile while delivery commands use --delivery-profile", () => {
  for (const command of ["capability profile status", "capability recommend", "capability status"]) {
    const flags = new Set(listOptions(command, { includeGlobal: false }).map((entry) => entry.flag));
    assert.equal(flags.has("--profile"), true, command);
    assert.equal(flags.has("--delivery-profile"), false, command);
  }
  const contractFlags = new Set(listOptions("contract create", { includeGlobal: false }).map((entry) => entry.flag));
  assert.equal(contractFlags.has("--delivery-profile"), true);
  assert.equal(contractFlags.has("--profile"), false);
});

test("nearest command suggestions favor the same hierarchy", () => {
  assert.deepEqual(
    suggestCommand("autonomy delivry aproove"),
    ["autonomy delivery approve", "autonomy delivery propose", "autonomy delivery action"],
  );
  assert.throws(() => suggestCommand("status", { limit: 0 }), /between 1 and 10/u);
});

test("every group carries its own description instead of a placeholder", () => {
  for (const group of COMMAND_CATALOG.children.filter((entry) => entry.kind === "group")) {
    assert.notEqual(group.description.en, "Related commands.", group.path_text);
    assert.notEqual(group.description.it, "Comandi correlati.", group.path_text);
  }
  const subgroups = [];
  const collect = (node) => {
    for (const child of node.children || []) {
      if (child.kind === "group" && node.kind === "group") subgroups.push([node, child]);
      collect(child);
    }
  };
  collect(COMMAND_CATALOG);
  assert.ok(subgroups.some(([, child]) => child.path_text === "autonomy requirement"));
  for (const [parent, child] of subgroups) {
    assert.notEqual(child.description.en, parent.description.en, child.path_text);
    assert.notEqual(child.description.it, parent.description.it, child.path_text);
  }
  assert.doesNotMatch(findCommand("autonomy requirement").description.en, /delivery/u);
});

test("phase and step help lists every shipped default phase, including operations", async () => {
  const { readFile } = await import("node:fs/promises");
  const template = JSON.parse(await readFile(new URL("../../templates/sdlc-config.json", import.meta.url), "utf8"));
  for (const [command, flag] of [["incident record", "--phase"], ["story complete-step", "--step"]]) {
    const entry = listOptions(command, { includeGlobal: false }).find((option) => option.flag === flag);
    assert.ok(entry, `${command} ${flag}`);
    for (const phase of template.phase_order) {
      assert.match(entry.description.en, new RegExp(`\\b${phase}\\b`, "u"), `${command} ${flag} en: ${phase}`);
      assert.match(entry.description.it, new RegExp(`\\b${phase}\\b`, "u"), `${command} ${flag} it: ${phase}`);
    }
  }
});

test("formal approval commands advertise the approver options their handlers require", () => {
  for (const command of ["breakdown approve", "dependency approve", "autonomy delivery revoke", "autonomy delivery close"]) {
    const flags = new Map(listOptions(command, { includeGlobal: false }).map((entry) => [entry.flag, entry]));
    assert.equal(flags.get("--actor-type")?.required, true, `${command} --actor-type`);
    assert.ok(flags.get("--approval-source")?.required_when, `${command} --approval-source`);
    assert.ok(flags.get("--approval-evidence"), `${command} --approval-evidence`);
    const node = findCommand(command);
    assert.match(node.usage, /--actor-type/u, command);
    for (const example of node.examples || []) {
      assert.match(example, /--actor-type human --approval-source explicit-user/u, `${command}: ${example}`);
    }
  }
});

test("breakdown and dependency help examples use the formats their parsers accept", async () => {
  const { parseBreakdownItemRef, parseDependencyEdge } = await import("../../lib/lifecycle/story.mjs");
  const valueAfter = (example, flag) => [...example.matchAll(new RegExp(`${flag} (\\S+)`, "gu"))].map((match) => match[1]);
  for (const example of findCommand("breakdown propose").examples) {
    for (const item of valueAfter(example, "--item")) assert.doesNotThrow(() => parseBreakdownItemRef(item), item);
  }
  for (const example of findCommand("dependency propose").examples) {
    for (const edge of valueAfter(example, "--edge")) assert.doesNotThrow(() => parseDependencyEdge(edge), edge);
  }
  assert.equal(listOptions("breakdown propose", { includeGlobal: false }).find((entry) => entry.flag === "--item").value, "type:id");
});
