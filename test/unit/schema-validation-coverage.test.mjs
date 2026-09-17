import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const schemaDirectory = path.join(repoRoot, "schemas");

/**
 * Schemas that describe input or derived shapes with no persisting writer:
 * nothing in this package writes a record of these kinds to disk, so there is
 * no write to validate. They stay published because they document contracts
 * consumed from outside, computed in memory, or referenced only by another
 * schema's `$ref`.
 *
 * This list is a ratchet, not an allowance: adding a schema without a
 * validation call site fails this test, and wiring one up requires deleting
 * its line here. It may shrink freely; it must never grow silently.
 */
const UNVALIDATED_SCHEMAS = Object.freeze([
  "governance-policy-revocation.schema.json",
  "orchestration.schema.json",
  "portfolio-manifest.schema.json",
  "release-artifact-policy.schema.json",
  "report-query.schema.json",
  "workflow-effective-definition.schema.json",
]);

const SOURCE_DIRECTORIES = Object.freeze(["bin", "lib", "scripts"]);
const SOURCE_EXTENSIONS = Object.freeze([".mjs", ".js", ".cjs", ".py"]);

function readSourceCorpus() {
  const contents = [];
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { encoding: "utf8", withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(entryPath);
      } else if (entry.isFile() && SOURCE_EXTENSIONS.includes(path.extname(entry.name))) {
        contents.push(fs.readFileSync(entryPath, "utf8"));
      }
    }
  }
  for (const directory of SOURCE_DIRECTORIES) visit(path.join(repoRoot, directory));
  return contents.join("\n");
}

function schemaNames() {
  return fs.readdirSync(schemaDirectory, { encoding: "utf8" })
    .filter((name) => name.endsWith(".schema.json"))
    .sort();
}

/** A schema is reachable when source names it, or a reachable schema `$ref`s it. */
function reachableSchemas(names, corpus) {
  const references = new Map(names.map((name) => {
    const document = fs.readFileSync(path.join(schemaDirectory, name), "utf8");
    return [name, names.filter((other) => other !== name && document.includes(other))];
  }));

  const reachable = new Set(names.filter((name) => corpus.includes(name)));
  const queue = [...reachable];
  while (queue.length > 0) {
    for (const referenced of references.get(queue.pop()) ?? []) {
      if (!reachable.has(referenced)) {
        reachable.add(referenced);
        queue.push(referenced);
      }
    }
  }
  return reachable;
}

test("every published schema is either reachable from code or listed as a known validation gap", () => {
  const names = schemaNames();
  const reachable = reachableSchemas(names, readSourceCorpus());
  const gaps = names.filter((name) => !reachable.has(name)).sort();

  assert.deepEqual(
    gaps,
    [...UNVALIDATED_SCHEMAS].sort(),
    "Schema validation coverage changed. Wiring a schema up means deleting its line from "
      + "UNVALIDATED_SCHEMAS; adding a schema with no validation call site is not allowed.",
  );
});

test("the known-gap list names only schemas that exist", () => {
  const names = new Set(schemaNames());
  for (const name of UNVALIDATED_SCHEMAS) {
    assert.ok(names.has(name), `UNVALIDATED_SCHEMAS names a schema that does not exist: ${name}`);
  }
  assert.equal(
    new Set(UNVALIDATED_SCHEMAS).size,
    UNVALIDATED_SCHEMAS.length,
    "UNVALIDATED_SCHEMAS contains duplicates",
  );
});

test("the story claim and handoff contracts are validated on write", () => {
  const cli = fs.readFileSync(path.join(repoRoot, "bin/agentic-sdlc.mjs"), "utf8");
  assert.match(cli, /assertRecordSchema\(claim, "claim\.schema\.json"/u);
  assert.match(cli, /assertRecordSchema\(handoff, "handoff\.schema\.json"/u);
});
