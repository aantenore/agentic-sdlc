import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

import { AGENT_HOSTS, AGENT_HOST_OVERRIDE_ENV } from "../lib/agent-host.mjs";
import { buildContext } from "../lib/engine/common.mjs";
import { baselineRefreshAnchorRef, deliveredWorkApprovalChainErrors } from "../lib/engine/baseline-refresh.mjs";
import { readBaselineSummaries } from "../lib/engine/story.mjs";
import { hashApprovalSubject } from "../lib/lifecycle/authorization.mjs";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(REPOSITORY_ROOT, "bin", "agentic-sdlc.mjs");
const TEMPORARY = new Set();
const ISOLATED_ENVIRONMENT_KEYS = [
  "CI",
  "GITHUB_ACTIONS",
  "GITHUB_ACTOR",
  AGENT_HOST_OVERRIDE_ENV,
  ...AGENT_HOSTS.flatMap((host) => [...host.markers, ...Object.values(host.env).filter(Boolean)]),
];

after(() => {
  if (process.env.AGENTIC_SDLC_KEEP_TEST_TMP === "1") return;
  for (const directory of TEMPORARY) fs.rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  TEMPORARY.clear();
});

function mustRun(args, project) {
  const env = { ...process.env };
  for (const key of ISOLATED_ENVIRONMENT_KEYS) delete env[key];
  const result = spawnSync(process.execPath, [CLI, ...args, "--root", project], {
    cwd: project,
    encoding: "utf8",
    env,
    timeout: 300_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  assert.equal(result.status, 0, `${args.join(" ")}\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  return result;
}

function project(label, files) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `agentic-sdlc-baseline-scale-${label}-`));
  TEMPORARY.add(directory);
  mustRun(["init", "--project-name", "Baseline scale"], directory);
  for (let index = 0; index < files; index += 1) {
    const folder = path.join(directory, "src", `module-${index % 50}`);
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, `file-${index}.mjs`), `export const value${index} = ${index};\n`);
  }
  fs.writeFileSync(path.join(directory, "README.md"), "# Baseline scale\n");
  return directory;
}

function approvedBaseline(directory) {
  mustRun(["baseline", "propose", "--id", "BASELINE-INITIAL", "--document", "README.md", "--source", "src"], directory);
  mustRun([
    "baseline", "approve", "--id", "BASELINE-INITIAL",
    "--actor-type", "human", "--approval-source", "explicit-user", "--summary", "Accurate",
  ], directory);
  return readBaseline(directory, "BASELINE-INITIAL");
}

function readBaseline(directory, id) {
  return JSON.parse(fs.readFileSync(path.join(directory, ".sdlc", "baseline", `${id}.json`), "utf8"));
}

function writeBaseline(directory, record) {
  fs.writeFileSync(path.join(directory, ".sdlc", "baseline", `${record.id}.json`), `${JSON.stringify(record, null, 2)}\n`);
}

function approve(record, approval) {
  record.approvals = [];
  record.status = "approved";
  record.approvals = [{ ...approval, approved_content_hash: hashApprovalSubject(record) }];
  return record;
}

/** A line of refreshes approved from delivered work, as the refresh command records them. */
function writeRefreshLine(directory, base, count, { anchors }) {
  const anchorRef = { id: base.id, approved_content_hash: base.approvals.at(-1).approved_content_hash };
  let previous = base;
  for (let revision = 2; revision <= count + 1; revision += 1) {
    const id = `BASELINE-INITIAL-R${revision}`;
    const record = {
      ...base,
      id,
      created_at: new Date(Date.parse(base.created_at) + revision * 1000).toISOString(),
      refresh: {
        schema: "baseline-refresh:v1",
        previous_baseline_ref: {
          id: previous.id,
          path: `.sdlc/baseline/${previous.id}.json`,
          approved_content_hash: previous.approvals.at(-1).approved_content_hash,
        },
        ...(anchors ? { anchor_baseline_ref: anchorRef } : {}),
        delta: { added: [], changed: [], removed: [] },
        explanations: [],
        unexplained: [],
      },
    };
    approve(record, {
      id: `APR-R${revision}`,
      baseline_id: id,
      status: "approved",
      scope: "baseline-refresh:delivered-work",
      previous_baseline_id: previous.id,
      approval_source: "delivered-work",
      approved_by: { id: "agentic-sdlc-baseline-refresh", type: "system", name: null, email: null, source: "policy" },
      created_at: record.created_at,
    });
    writeBaseline(directory, record);
    previous = record;
  }
  return previous;
}

test("a long line of refreshes approved from delivered work still rests on its person's approval", () => {
  for (const anchors of [true, false]) {
    const directory = project(anchors ? "anchored" : "legacy", 20);
    const base = approvedBaseline(directory);
    const tip = writeRefreshLine(directory, base, 120, { anchors });
    const context = buildContext({ root: directory });
    assert.deepEqual(deliveredWorkApprovalChainErrors(context, tip), []);
    assert.equal(baselineRefreshAnchorRef(context, tip).id, "BASELINE-INITIAL");

    // The anchor must still hold the approval the line recorded.
    const anchor = readBaseline(directory, "BASELINE-INITIAL");
    anchor.summary = "Edited after approval";
    writeBaseline(directory, anchor);
    assert.match(deliveredWorkApprovalChainErrors(context, tip).join("\n"), /BASELINE-INITIAL has no current approval/u);
  }
});

test("a refresh that names a different anchor from its predecessor is refused", () => {
  const directory = project("anchor-mismatch", 20);
  const base = approvedBaseline(directory);
  writeRefreshLine(directory, base, 3, { anchors: true });
  const context = buildContext({ root: directory });
  const tip = readBaseline(directory, "BASELINE-INITIAL-R4");
  tip.refresh.anchor_baseline_ref = { id: "BASELINE-INITIAL-R2", approved_content_hash: "0".repeat(64) };
  approve(tip, { ...tip.approvals[0] });
  assert.match(deliveredWorkApprovalChainErrors(context, tip).join("\n"), /names anchor BASELINE-INITIAL-R2, but BASELINE-INITIAL-R3 rests on BASELINE-INITIAL/u);
});

test("baseline summaries come from the derived index until a record changes", () => {
  const directory = project("index", 20);
  const base = approvedBaseline(directory);
  writeRefreshLine(directory, base, 5, { anchors: true });
  const context = buildContext({ root: directory });
  const first = readBaselineSummaries(context);
  assert.deepEqual(first.map((item) => item.id), [
    "BASELINE-INITIAL",
    ...[2, 3, 4, 5, 6].map((revision) => `BASELINE-INITIAL-R${revision}`),
  ]);
  assert.equal(first.at(-1).refresh.previous_baseline_ref.id, "BASELINE-INITIAL-R5");
  const indexPath = path.join(directory, ".sdlc", "indexes", "baseline-index.json");
  assert.equal(fs.existsSync(indexPath), true);

  const tip = readBaseline(directory, "BASELINE-INITIAL-R6");
  tip.status = "proposed";
  writeBaseline(directory, tip);
  assert.equal(readBaselineSummaries(context).at(-1).status, "proposed");
  fs.rmSync(path.join(directory, ".sdlc", "baseline", "BASELINE-INITIAL-R6.json"));
  assert.equal(readBaselineSummaries(context).at(-1).id, "BASELINE-INITIAL-R5");
  // A damaged index is rebuilt from the records.
  fs.writeFileSync(indexPath, "not json");
  assert.equal(readBaselineSummaries(context).length, 5);
});

test("a project with more files than one redaction budget allows still gets its baseline", () => {
  const directory = project("large", 4800);
  const proposed = JSON.parse(mustRun([
    "baseline", "propose", "--id", "BASELINE-INITIAL", "--document", "README.md", "--source", "src", "--json",
  ], directory).stdout);
  assert.equal(proposed.status, "proposed");
  assert.equal(Object.keys(readBaseline(directory, "BASELINE-INITIAL").source_hashes).length, 4801);
});
