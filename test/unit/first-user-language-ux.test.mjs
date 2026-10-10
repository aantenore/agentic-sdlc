import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildHelpModel, renderHelp } from "../../lib/cli/help.mjs";

const TEST_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CLI = path.join(TEST_ROOT, "bin", "agentic-sdlc.mjs");

function runCli(args) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: TEST_ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      NO_COLOR: "1",
    },
  });
  assert.equal(
    result.status,
    0,
    `CLI failed (${result.status}):\n${result.stdout}\n${result.stderr}`,
  );
  return result.stdout;
}

test("output link help names render evidence explicitly and keeps the legacy spelling", () => {
  const model = buildHelpModel(["output", "link"]);
  const flags = new Map(model.options.map((entry) => [entry.flag, entry]));

  assert.match(model.human.result, /Use --render-evidence/u);
  assert.match(
    flags.get("--render-evidence")?.description || "",
    /PNG, JPEG, WebP, PDF render.*render-verification-receipt:v1[\s\S]*not functional or test evidence/iu,
  );
  assert.match(
    flags.get("--evidence")?.description || "",
    /Legacy alias for --render-evidence[\s\S]*not functional or test evidence/iu,
  );
  assert.match(model.usage, /\[--render-evidence <path>\] \[--evidence <path>\]/u);
  assert.equal(
    model.examples.some((example) => /--render-evidence evidence\/implementation-report-render\.png/u.test(example)),
    true,
  );

  const italian = renderHelp(["output", "link"], { locale: "it" });
  assert.match(italian, /Usa --render-evidence per questa verifica/u);
  assert.match(italian, /Non è una prova funzionale o di test/u);
  assert.match(italian, /Alias precedente di --render-evidence/u);
});

test("Italian first-user capability and implementation-output prompts stay in context", {
  timeout: 30_000,
}, (t) => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-sdlc-first-user-language-"));
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));

  runCli(["init", "--root", project, "--project-name", "First User Language"]);
  runCli([
    "story",
    "create", "--no-derived-verification",
    "--root",
    project,
    "--id",
    "ST-FIRST-USER",
    "--title",
    "Implement local behavior",
    "--status",
    "draft",
  ]);

  const profile = runCli([
    "capability",
    "profile",
    "propose",
    "--root",
    project,
    "--id",
    "CAP-FIRST-USER",
    "--story",
    "ST-FIRST-USER",
    "--phase",
    "implementation",
    "--context-file",
    ".sdlc/project.json",
    "--locale",
    "it",
  ]);
  assert.match(profile, /Proposto il perimetro di evidenze e strumenti CAP-FIRST-USER/u);
  assert.match(profile, /Ambito del lavoro: fase implementation, attività ST-FIRST-USER/u);
  assert.doesNotMatch(
    profile,
    /\b(?:assessment|I need your decision|Project evidence and boundaries|What this is|Before I choose tools)\b/iu,
  );

  const outputTemplate = runCli([
    "output",
    "template",
    "propose",
    "--root",
    project,
    "--type",
    "implementation-summary",
    "--id",
    "IMPLEMENTATION-SUMMARY-FIRST-USER",
    "--summary",
    "Riepilogo della modifica locale",
    "--locale",
    "it",
  ]);
  assert.match(
    outputTemplate,
    /Proposto il formato di risultato IMPLEMENTATION-SUMMARY-FIRST-USER per implementation-summary/u,
  );
  assert.match(outputTemplate, /struttura, livello di dettaglio e modalità di consegna/u);
  assert.doesNotMatch(
    outputTemplate,
    /\b(?:assessment|I need your decision|Output format|What this is|How I can present)\b/iu,
  );

  const pending = runCli([
    "approval",
    "requests",
    "--root",
    project,
    "--story",
    "ST-FIRST-USER",
    "--locale",
    "it",
  ]);
  assert.match(pending, /Fonti e limiti di accesso/u);
  assert.match(pending, /Struttura e formato del risultato/u);
  assert.doesNotMatch(
    pending,
    /\b(?:assessment|I need your decision|Project evidence and boundaries|Output format|What this is)\b/iu,
  );
});

test("first-user local-release help preserves conditional build authorization and complete action scope", () => {
  const action = buildHelpModel(["autonomy", "delivery", "action"]);
  const actionFlags = new Map(action.options.map((entry) => [entry.flag, entry]));
  const root = buildHelpModel([]);
  const globalFlags = new Map(root.options.map((entry) => [entry.flag, entry]));
  const targetRoot = buildHelpModel(["autonomy", "delivery", "propose"])
    .options.find((entry) => entry.flag === "--target-root");

  assert.match(
    globalFlags.get("--full")?.description || "",
    /machine\/JSON details omitted from compact output/u,
  );
  assert.match(
    targetRoot?.description || "",
    /before rollback\.verify, data\.migrate, data\.rollback, or release\.local/u,
  );
  assert.match(
    action.human.result,
    /request build\.local first without confirmation[\s\S]*only if it reports checkpoint_required[\s\S]*repeat with direct approval/iu,
  );
  assert.match(
    action.human.result,
    /before rollback\.verify, data\.migrate, data\.rollback, or release\.local/u,
  );
  assert.equal(actionFlags.has("--confirm-action"), true);

  const buildExamples = action.examples.filter((example) => /--action build\.local/u.test(example));
  assert.equal(buildExamples.length, 3);
  assert.doesNotMatch(buildExamples[0], /--confirm-action/u);
  assert.match(buildExamples[1], /--confirm-action.*--actor-type human.*--approval-source explicit-user/u);
  assert.match(
    buildExamples[2],
    /--outcome passed.*--authorization-receipt.*--evidence/u,
  );
});

test("first-user docs explain compact JSON, governed root creation, and proposal-bound output authorization", () => {
  const gettingStarted = fs.readFileSync(path.join(TEST_ROOT, "docs", "getting-started.md"), "utf8");
  const configurationSafety = fs.readFileSync(
    path.join(TEST_ROOT, "docs", "configuration-safety.md"),
    "utf8",
  );
  const skill = fs.readFileSync(
    path.join(TEST_ROOT, "skills", "agentic-sdlc", "SKILL.md"),
    "utf8",
  );

  assert.match(
    gettingStarted,
    /Request `build\.local` once without `--confirm-action`[\s\S]*If, and only if, the response is `checkpoint_required`[\s\S]*external builder create[\s\S]*Complete the same `build\.local` authorization[\s\S]*`rollback\.verify`[\s\S]*`data\.migrate`\/`data\.rollback`[\s\S]*`release\.local`/u,
  );
  assert.match(
    configurationSafety,
    /config migrate --root \/path\/to\/project --json\n[\s\S]*config migrate --root \/path\/to\/project --json --full/u,
  );
  assert.match(
    configurationSafety,
    /`--full` expands details omitted from compact machine\/JSON output/u,
  );
  assert.match(
    skill,
    /Proposal-bound `output\.link` is the[\s\S]*exception: it always requires and consumes the proposal-bound[\s\S]*even when the[\s\S]*action as a checkpoint/u,
  );
});
