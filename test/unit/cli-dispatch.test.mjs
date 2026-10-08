import assert from "node:assert/strict";
import test from "node:test";

import {
  COMMAND_CATALOG,
  findCommand,
  listCommandPaths,
  listOptions,
} from "../../lib/cli/command-catalog.mjs";
import {
  CliDispatchMetadataError,
  catalogOptionMetadata,
  commandMutationIntent,
  createCommandHandlerRegistry,
  listCanonicalActions,
  resolveCommand,
} from "../../lib/cli/dispatch.mjs";

test("every catalog leaf has immutable serializable dispatch metadata", () => {
  for (const commandPath of listCommandPaths()) {
    const command = findCommand(commandPath);
    assert.match(command.canonical_action, /^[a-z0-9-]+(?:\.[a-z0-9-]+)*$/u, commandPath);
    assert.ok(["always", "never", "when-option"].includes(command.mutation.mode), commandPath);
    assert.equal(Object.isFrozen(command.mutation), true, commandPath);
    assert.doesNotThrow(() => JSON.stringify({
      canonical_action: command.canonical_action,
      mutation: command.mutation,
    }), commandPath);
  }
});

test("resolver uses the longest exact path and preserves canonical aliases", () => {
  const route = resolveCommand(["route"]);
  const routeDecide = resolveCommand(["route", "decide"]);
  assert.equal(route.canonical_action, "route.decide");
  assert.equal(routeDecide.canonical_action, "route.decide");
  assert.deepEqual(routeDecide.args, []);

  const legacyRequirement = resolveCommand(["requirement", "create", "trailing"]);
  assert.equal(legacyRequirement.canonical_action, "requirement.propose");
  assert.deepEqual(legacyRequirement.matched_path, ["requirement", "create"]);
  assert.deepEqual(legacyRequirement.args, ["trailing"]);

  const assessment = resolveCommand("assessment status");
  assert.equal(assessment.canonical_action, "assessment.proposal.status");
  assert.equal(resolveCommand("autonomy delivery"), null);
  assert.equal(resolveCommand("does not exist"), null);
});

test("exactly seven commands derive conditional mutation intent from runtime options", () => {
  const conditional = listCommandPaths()
    .filter((commandPath) => findCommand(commandPath).mutation.mode === "when-option")
    .sort();
  assert.deepEqual(conditional, [
    "autonomy delivery explain",
    "config migrate",
    "gate check",
    "migration active",
    "migration identity",
    "report activity",
    "report query",
  ]);

  for (const commandPath of conditional) {
    assert.equal(commandMutationIntent(findCommand(commandPath), {}), false, commandPath);
  }
  for (const commandPath of [
    "autonomy delivery explain",
    "gate check",
    "report activity",
    "report query",
  ]) {
    assert.equal(commandMutationIntent(findCommand(commandPath), { out: "report.json" }), true, commandPath);
    assert.equal(commandMutationIntent(findCommand(commandPath), { out: "" }), false, commandPath);
  }
  for (const commandPath of ["config migrate", "migration active"]) {
    assert.equal(commandMutationIntent(findCommand(commandPath), { apply: true }), true, commandPath);
    assert.equal(commandMutationIntent(findCommand(commandPath), { apply: false }), false, commandPath);
  }
  const identity = findCommand("migration identity");
  assert.equal(commandMutationIntent(identity, { apply: true }), true);
  assert.equal(commandMutationIntent(identity, { recover: true }), true);
  assert.equal(commandMutationIntent(identity, { apply: false, recover: false }), false);

  assert.equal(commandMutationIntent(findCommand("archive closed"), {}), true);
  assert.equal(commandMutationIntent(findCommand("trace compact"), {}), true);
});

test("the installed-capability inventory is a read-only command that needs no project data", () => {
  const inventory = findCommand("capability inventory");
  assert.equal(inventory.canonical_action, "capability.inventory");
  assert.deepEqual(inventory.mutation, { mode: "never" });
  assert.equal(inventory.effect, "read");
  assert.equal(commandMutationIntent(inventory, {}), false);
  assert.equal(inventory.arguments, "none");
  assert.equal(resolveCommand("capability inventory").canonical_action, "capability.inventory");
});

test("unknown or incomplete mutation metadata fails closed", () => {
  assert.throws(() => commandMutationIntent(null, {}), CliDispatchMetadataError);
  assert.throws(
    () => commandMutationIntent({ path_text: "unsafe", canonical_action: "unsafe", mutation: null }, {}),
    /missing mutation metadata/u,
  );
  assert.throws(
    () => commandMutationIntent({
      path_text: "unsafe",
      canonical_action: "unsafe",
      mutation: { mode: "when-option", match: "any", conditions: [] },
    }, {}),
    /at least one mutation condition/u,
  );
});

test("handler registry enforces complete catalog parity before dispatch", async () => {
  const calls = [];
  const complete = Object.fromEntries(listCanonicalActions().map((action) => [
    action,
    ({ resolution }) => calls.push(resolution.canonical_action),
  ]));
  const registry = createCommandHandlerRegistry(complete);
  assert.deepEqual(registry.actions, listCanonicalActions());
  await registry.dispatch(resolveCommand("route"));
  assert.deepEqual(calls, ["route.decide"]);

  const firstAction = listCanonicalActions()[0];
  const missing = { ...complete };
  delete missing[firstAction];
  assert.throws(() => createCommandHandlerRegistry(missing), new RegExp(`Missing handlers: ${firstAction}`, "u"));
  assert.throws(
    () => createCommandHandlerRegistry({ ...complete, "unknown.action": () => {} }),
    /Unknown handlers: unknown\.action/u,
  );
});

test("parser metadata is derived from catalog flags including trace evidence binding", () => {
  const metadata = catalogOptionMetadata(COMMAND_CATALOG);
  for (const name of ["root", "json", "target-event", "redaction-policy", "recover", "recovery-nonce"]) {
    assert.equal(metadata.known.includes(name), true, name);
  }
  for (const name of ["json", "recover"]) assert.equal(metadata.boolean.includes(name), true, name);
  assert.equal(metadata.repeatable.includes("target-event"), true);

  const bindingOptions = new Map(
    listOptions("trace evidence bind", { includeGlobal: false }).map((descriptor) => [descriptor.name, descriptor]),
  );
  assert.equal(bindingOptions.get("target-event")?.required, true);
  assert.equal(bindingOptions.get("target-event")?.repeatable, true);
  assert.equal(bindingOptions.get("redaction-policy")?.required, true);
  assert.deepEqual(bindingOptions.get("redaction-policy")?.values, [
    "legacy_evidence_v1",
    "operational_evidence_v1",
    "operational_v2",
  ]);
});
