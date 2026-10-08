import assert from "node:assert/strict";
import test from "node:test";

import { normalizeCapabilityInventoryPolicy } from "../../lib/capability-inventory.mjs";
import { findForbiddenHumanGuidanceTerms } from "../../lib/human-guidance.mjs";
import {
  CAPABILITY_SUGGESTION_SCHEMA_VERSION,
  buildCapabilitySuggestionRecord,
  capabilitySuggestionDetailLines,
  capabilitySuggestionPrimaryLines,
} from "../../lib/lifecycle/capability-suggestion.mjs";

function match(type, name, extra = {}) {
  return {
    type,
    name,
    description: `${name} description`,
    source: "user-skills",
    path: `~/.skills/${name}/SKILL.md`,
    matched_tags: ["react"],
    ...extra,
  };
}

function record(overrides = {}) {
  return buildCapabilitySuggestionRecord({
    storyId: "ST-001",
    phase: "implementation",
    basis: "approved_profile",
    profileId: "CAP-PROFILE-ST-001",
    tags: ["react"],
    matches: [match("skill", "react-review"), match("mcp", "docs"), match("plugin", "widgets")],
    commands: ["agentic-sdlc capability recommend --id CAP-REC-ST-001 --profile CAP-PROFILE-ST-001 --from-inventory"],
    ...overrides,
  });
}

test("the suggestion record only describes: it applies nothing and carries the command to record it", () => {
  const suggestion = record();
  assert.equal(suggestion.schema_version, CAPABILITY_SUGGESTION_SCHEMA_VERSION);
  assert.equal(suggestion.status, "available");
  assert.equal(suggestion.applies_automatically, false);
  assert.equal(suggestion.command, suggestion.commands[0]);
  assert.deepEqual(suggestion.matches.map((item) => item.name), ["react-review", "docs", "widgets"]);
  assert.deepEqual(Object.keys(suggestion.matches[0]).sort(), ["description", "matched_tags", "name", "path", "source", "type"]);
  assert.equal(record({ commands: [] }).command, null);
  assert.equal(JSON.stringify(suggestion).includes("score"), false, "ranking internals are not part of the record");
});

test("the plain-language message names at most three tools and reads cleanly in both languages", () => {
  const many = record({
    matches: ["a-one", "b-two", "c-three", "d-four", "e-five"].map((name) => match("skill", name)),
    totalMatches: 7,
  });
  assert.match(many.message, /: a-one \(skill\), b-two \(skill\), c-three \(skill\) and 4 more\. Nothing is used or approved yet;/u);
  assert.match(many.message, /ask me to put them forward for your review\.$/u);
  const italian = record({ locale: "it", matches: [match("mcp", "docs"), match("plugin", "widgets")] });
  assert.match(italian.message, /^Strumenti già installati che sembrano utili per questo lavoro: docs \(server di strumenti\), widgets \(plugin\)\./u);
  assert.match(italian.message, /chiedimi di proporli alla tua revisione\.$/u);
  for (const suggestion of [many, italian, record({ basis: "project_detection" }), record({ basis: "project_detection", locale: "it" })]) {
    assert.deepEqual(findForbiddenHumanGuidanceTerms(suggestion.message), [], suggestion.message);
    assert.doesNotMatch(suggestion.message, /--[a-z]|agentic-sdlc|\.sdlc|\bST-\d/iu);
  }
});

test("before any evidence is approved the message says that comes first", () => {
  const detected = record({ basis: "project_detection", profileId: null });
  assert.match(detected.message, /the project evidence and boundaries need your review first/u);
  assert.match(
    record({ basis: "project_detection", locale: "it" }).message,
    /prima vanno riviste le evidenze e i limiti del progetto/u,
  );
});

test("a tool name carrying internal terminology stays out of the plain-language message", () => {
  const suggestion = record({
    matches: [match("skill", "schema-designer"), match("skill", "react-review"), match("skill", "profile-manager")],
  });
  assert.match(suggestion.message, /: react-review \(skill\) and 2 more\. Nothing/u);
  assert.equal(suggestion.message.includes("schema"), false);
  assert.equal(suggestion.message.includes("profile"), false);
  assert.deepEqual(findForbiddenHumanGuidanceTerms(suggestion.message), []);
  assert.equal(suggestion.matches.length, 3, "the technical record still lists every match");

  const onlyInternal = record({ matches: [match("skill", "schema-designer")], totalMatches: 2 });
  assert.match(onlyInternal.message, /: 2 installed tools\. Nothing/u);
  assert.deepEqual(findForbiddenHumanGuidanceTerms(onlyInternal.message), []);
});

test("primary and detail lines expose the message, the matches, and the command", () => {
  const suggestion = record({ totalMatches: 5 });
  assert.deepEqual(capabilitySuggestionPrimaryLines(suggestion), [suggestion.message]);
  assert.deepEqual(capabilitySuggestionPrimaryLines(null), []);
  assert.deepEqual(capabilitySuggestionPrimaryLines(undefined), []);

  const details = capabilitySuggestionDetailLines(suggestion, false);
  assert.equal(details[0], "Installed-tool suggestion (declared technology: react; basis: approved_profile):");
  assert.equal(details[1], "skill react-review [user-skills] ~/.skills/react-review/SKILL.md - react-review description (matches: react)");
  assert.ok(details.includes("... 2 more matches; run capability inventory for the whole list"));
  assert.equal(details.at(-1), `Command to record the proposal: ${suggestion.command}`);
  const italian = capabilitySuggestionDetailLines(suggestion, true);
  assert.match(italian[0], /^Suggerimento strumenti installati \(tecnologie dichiarate: react; base: approved_profile\):$/u);
  assert.match(italian[1], /\(corrisponde a: react\)$/u);
  assert.match(italian.at(-1), /^Comando per registrare la proposta: /u);
  assert.deepEqual(capabilitySuggestionDetailLines(null), []);
});

test("suggestions can be switched off independently of the inventory", () => {
  assert.equal(normalizeCapabilityInventoryPolicy({}).suggest, true);
  assert.equal(normalizeCapabilityInventoryPolicy({ suggest: false }).suggest, false);
  assert.equal(normalizeCapabilityInventoryPolicy({ suggest: false }).enabled, true);
  assert.throws(() => normalizeCapabilityInventoryPolicy({ suggest: "no" }), /suggest must be a boolean/u);
});
