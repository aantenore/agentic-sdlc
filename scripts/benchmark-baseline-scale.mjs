#!/usr/bin/env node
// Measures how baseline records scale with project size and refresh history.
// It drives the CLI only, so the same script runs against any checkout:
//   node scripts/benchmark-baseline-scale.mjs [--cli path/to/bin/agentic-sdlc.mjs]
//     [--files 5000] [--revisions 1000] [--revision-files 1000] [--chain 100]
// Every scenario builds its own temporary project and removes it afterwards.
import { execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : fallback;
};
const CLI = path.resolve(option("cli", path.join(ROOT, "bin", "agentic-sdlc.mjs")));
const LARGE_FILES = Number(option("files", 5000));
const REVISIONS = Number(option("revisions", 1000));
const REVISION_FILES = Number(option("revision-files", 1000));
const CHAIN = Number(option("chain", 100));

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

// Same subject as hashApprovalSubject: the record without its volatile top-level fields.
function approvalHash(record) {
  const volatile = new Set(["__path", "__relative_path", "approvals", "audit", "created_at", "updated_at", "approved_at", "approved_by", "status"]);
  const subject = Object.fromEntries(Object.entries(record).filter(([key]) => !volatile.has(key)));
  return crypto.createHash("sha256").update(stableJson(subject)).digest("hex");
}

function cli(project, commandArgs, { allowFailure = false } = {}) {
  const started = performance.now();
  const result = spawnSync(process.execPath, [CLI, ...commandArgs, "--root", project], {
    cwd: project,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 1024,
    env: { ...process.env, CI: "", GITHUB_ACTIONS: "" },
  });
  const ms = Math.round(performance.now() - started);
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`${commandArgs.join(" ")} failed:\n${result.stdout}\n${result.stderr}`);
  }
  return { ms, status: result.status, output: `${result.stdout}\n${result.stderr}` };
}

function project(label, files) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `baseline-scale-${label}-`));
  cli(directory, ["init", "--project-name", "Baseline scale"]);
  for (let index = 0; index < files; index += 1) {
    const folder = path.join(directory, "src", `module-${index % 100}`);
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, `file-${index}.mjs`), `export const value${index} = ${index};\n`);
  }
  fs.writeFileSync(path.join(directory, "README.md"), "# Baseline scale\n");
  return directory;
}

function raiseDiscoveryLimit(directory, limit) {
  const configPath = path.join(directory, ".sdlc", "config.json");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  config.baseline_policy = { ...config.baseline_policy, max_discovered_files: limit };
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  const preview = JSON.parse(cli(directory, ["config", "migrate", "--json"]).output.split("\n").find((line) => line.startsWith("{")) || "{}");
  const plan = preview.plan?.plan_hash;
  if (plan) cli(directory, ["config", "migrate", "--apply", "--plan-hash", plan, "--actor-type", "human"]);
}

function approvedBaseline(directory) {
  cli(directory, ["baseline", "propose", "--id", "BASELINE-INITIAL", "--document", "README.md", "--source", "src"]);
  cli(directory, ["baseline", "approve", "--id", "BASELINE-INITIAL", "--actor-type", "human", "--approval-source", "explicit-user", "--summary", "Accurate"]);
  return JSON.parse(fs.readFileSync(path.join(directory, ".sdlc", "baseline", "BASELINE-INITIAL.json"), "utf8"));
}

// A line of refreshes approved from delivered work, written as records.
function writeRefreshLine(directory, base, count) {
  let previous = base;
  for (let revision = 2; revision <= count + 1; revision += 1) {
    const id = `BASELINE-INITIAL-R${revision}`;
    const paths = Object.keys(previous.source_hashes);
    const changed = paths[revision % paths.length];
    const sourceHashes = { ...previous.source_hashes, [changed]: crypto.createHash("sha256").update(id).digest("hex") };
    const previousApproval = previous.approvals.at(-1);
    const record = {
      ...base,
      id,
      source_hashes: sourceHashes,
      created_at: new Date(Date.parse(base.created_at) + revision * 1000).toISOString(),
      approvals: [],
      refresh: {
        schema: "baseline-refresh:v1",
        previous_baseline_ref: {
          id: previous.id,
          path: `.sdlc/baseline/${previous.id}.json`,
          approved_content_hash: previousApproval.approved_content_hash,
        },
        delta: { added: [], changed: [changed], removed: [] },
        explanations: [{
          path: changed,
          change: "changed",
          sha256: sourceHashes[changed],
          story_id: `ST-${revision}`,
          delivery_profile_id: `AUT-${revision}`,
          merge_commit_sha: "0".repeat(40),
        }],
        unexplained: [],
      },
    };
    record.status = "approved";
    record.approvals = [{
      id: `APR-${revision}`,
      baseline_id: id,
      status: "approved",
      summary: "Delivered work",
      scope: "baseline-refresh:delivered-work",
      previous_baseline_id: previous.id,
      evidence: [],
      approval_source: "delivered-work",
      explicit_user_confirmation: false,
      provisional: false,
      approved_content_hash: approvalHash(record),
      hash_algorithm: "sha256:stable-json:v1",
      approved_by: { id: "agentic-sdlc-baseline-refresh", type: "system", name: null, email: null, source: "policy" },
      created_at: record.created_at,
    }];
    fs.writeFileSync(path.join(directory, ".sdlc", "baseline", `${id}.json`), `${JSON.stringify(record, null, 2)}\n`);
    previous = record;
  }
  return previous;
}

function directorySize(directory) {
  let total = 0;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    total += entry.isDirectory() ? directorySize(full) : fs.statSync(full).size;
  }
  return total;
}

const results = { cli: path.relative(process.cwd(), CLI) || CLI };
const cleanup = [];
try {
  // 1. A project above the default discovery limit.
  const large = project("large", LARGE_FILES);
  cleanup.push(large);
  if (LARGE_FILES > 5000) raiseDiscoveryLimit(large, LARGE_FILES);
  const proposal = cli(large, ["baseline", "propose", "--id", "BASELINE-INITIAL", "--document", "README.md", "--source", "src"], { allowFailure: true });
  results.large_project = {
    files: LARGE_FILES,
    propose_ok: proposal.status === 0,
    propose_ms: proposal.ms,
    error: proposal.status === 0 ? null : (proposal.output.match(/- Error: (.*)/u)?.[1] || "failed"),
  };

  // 2. A long refresh history: reading status and running the gate.
  const history = project("history", REVISION_FILES);
  cleanup.push(history);
  const base = approvedBaseline(history);
  writeRefreshLine(history, base, REVISIONS - 1);
  const statusCold = cli(history, ["baseline", "status", "--json"], { allowFailure: true });
  const statusWarm = cli(history, ["baseline", "status", "--json"], { allowFailure: true });
  results.refresh_history = {
    revisions: REVISIONS,
    files_per_revision: REVISION_FILES,
    baseline_records_mb: Math.round(directorySize(path.join(history, ".sdlc", "baseline")) / 1048576),
    status_first_ms: statusCold.ms,
    status_next_ms: statusWarm.ms,
  };

  // 3. A chain of refreshes approved from delivered work.
  const chain = project("chain", 50);
  cleanup.push(chain);
  writeRefreshLine(chain, approvedBaseline(chain), CHAIN);
  const gate = cli(chain, ["gate", "check", "--strict", "--json"], { allowFailure: true });
  results.delivered_chain = {
    refreshes: CHAIN,
    gate_ms: gate.ms,
    chain_limit_error: /refresh chain is longer than/u.test(gate.output),
  };

  // 4. Reading merged file contents from Git: one process per path versus one batch.
  const repo = project("git", 1000);
  cleanup.push(repo);
  execFileSync("git", ["init", "-q", repo]);
  execFileSync("git", ["-C", repo, "add", "-A"]);
  execFileSync("git", ["-C", repo, "-c", "user.name=bench", "-c", "user.email=bench@example.invalid", "commit", "-qm", "bench"]);
  const paths = Array.from({ length: 1000 }, (_, index) => `src/module-${index % 100}/file-${index}.mjs`);
  let started = performance.now();
  for (const sourcePath of paths) execFileSync("git", ["-C", repo, "cat-file", "blob", `HEAD:${sourcePath}`]);
  const perPath = performance.now() - started;
  started = performance.now();
  execFileSync("git", ["-C", repo, "cat-file", "--batch"], { input: paths.map((sourcePath) => `HEAD:${sourcePath}\n`).join(""), maxBuffer: 1 << 30 });
  const batch = performance.now() - started;
  results.git_reads = { paths: paths.length, one_process_per_path_ms: Math.round(perPath), one_batch_ms: Math.round(batch) };
} finally {
  for (const directory of cleanup) fs.rmSync(directory, { recursive: true, force: true });
}
console.log(JSON.stringify(results, null, 2));
