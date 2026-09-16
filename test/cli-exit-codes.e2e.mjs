import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(repoRoot, "bin/agentic-sdlc.mjs");

function run(args, options = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    timeout: 120_000,
    ...options,
  });
}

function temporaryProject(name) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `sdlc-exit-${name}-`));
  const initialized = run(["init", "--root", directory, "--project-name", "Exit codes"]);
  assert.equal(initialized.status, 0, initialized.stderr || initialized.stdout);
  return directory;
}

/**
 * The exit code is the only thing a pipeline reads when it does not parse
 * output. These cases pin the published contract; changing one is a breaking
 * change for every script that gates on it.
 */
test("a completed command exits 0", () => {
  assert.equal(run(["--version"]).status, 0);
  assert.equal(run(["--help"]).status, 0);
  assert.equal(run(["help", "requirement"]).status, 0);
});

test("an unresolvable command or option exits 2", () => {
  const unknown = run(["definitely-not-a-command"]);
  assert.equal(unknown.status, 2, unknown.stderr);

  const unknownChild = run(["requirement", "definitely-not-a-subcommand"]);
  assert.equal(unknownChild.status, 2, unknownChild.stderr);

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sdlc-exit-preset-"));
  const preset = path.join(directory, "unsafe.json");
  fs.writeFileSync(preset, `${JSON.stringify({ authorization: "AUTH-NOT-ALLOWED" })}\n`, "utf8");
  const rejected = run(["status", "--cli-preset", `@${preset}`], { cwd: directory });
  assert.equal(rejected.status, 2, rejected.stderr);
  fs.rmSync(directory, { force: true, recursive: true });
});

test("a request refused on its merits exits 1", () => {
  const directory = temporaryProject("refusal");
  try {
    const missingStory = run(["story", "claim", "--root", directory, "--id", "ST-ABSENT", "--agent", "tester"]);
    assert.equal(missingStory.status, 1, missingStory.stderr || missingStory.stdout);

    const missingOption = run(["requirement", "propose", "--root", directory]);
    assert.equal(missingOption.status, 1, missingOption.stderr || missingOption.stdout);
  } finally {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

test("a failure whose details are withheld does not disclose its category", () => {
  // The redacted path deliberately refuses to say what went wrong. The exit
  // code must not say it either, so it collapses to the broadest category.
  const absent = path.join(os.tmpdir(), "sdlc-exit-absent-project-xyz");
  fs.rmSync(absent, { force: true, recursive: true });
  const withheld = run(["status", "--root", absent]);
  assert.equal(withheld.status, 1, withheld.stderr || withheld.stdout);
  assert.match(withheld.stderr, /withheld/u);
});

test("the published contract is documented where operators look for it", () => {
  const selfService = fs.readFileSync(path.join(repoRoot, "docs/self-service-cli.md"), "utf8");
  for (const row of [
    "| `0` |",
    "| `1` |",
    "| `2` |",
    "| `3` |",
    "| `4` |",
    "| `70` |",
  ]) {
    assert.ok(selfService.includes(row), `docs/self-service-cli.md is missing exit code row ${row}`);
  }
});
