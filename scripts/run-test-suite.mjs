import path from "node:path";
import { once } from "node:events";
import fs from "node:fs";
import { run } from "node:test";
import { tap } from "node:test/reporters";
import { fileURLToPath } from "node:url";

export const TEST_CONCURRENCY_ENV = "AGENTIC_SDLC_TEST_CONCURRENCY";
export const DEFAULT_TEST_CONCURRENCY = 2;
export const MAX_TEST_CONCURRENCY = 8;
export const TEST_SHARD_ENV = "AGENTIC_SDLC_TEST_SHARD";
export const SHARD_WEIGHTS_SCHEMA = "agentic-sdlc.test-shard-weights.v1";
const PROJECT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const TEST_ROOT = path.join(PROJECT_ROOT, "test");
export const SHARD_WEIGHTS_FILE = path.join(TEST_ROOT, "shard-weights.json");

export function parseTestConcurrency(value) {
  if (value === undefined) return DEFAULT_TEST_CONCURRENCY;
  if (typeof value !== "string" || !/^[1-9][0-9]*$/u.test(value)) {
    throw new TypeError(
      `${TEST_CONCURRENCY_ENV} must be a positive integer; received ${JSON.stringify(value)}.`,
    );
  }

  const requested = BigInt(value);
  return requested > BigInt(MAX_TEST_CONCURRENCY)
    ? MAX_TEST_CONCURRENCY
    : Number(requested);
}

// "<index>/<total>", 1-based. Absent means "run everything".
export function parseTestShard(value) {
  if (value === undefined) return null;
  const match = typeof value === "string"
    ? /^([1-9][0-9]{0,3})\/([1-9][0-9]{0,3})$/u.exec(value)
    : null;
  if (match === null || Number(match[1]) > Number(match[2])) {
    throw new TypeError(
      `${TEST_SHARD_ENV} must be "<index>/<total>" with 1 <= index <= total (at most four digits each); received ${JSON.stringify(value)}.`,
    );
  }
  return { index: Number(match[1]), total: Number(match[2]) };
}

// Path of a test file relative to the project root, always with "/" separators,
// so the weights table reads the same on every platform.
export function projectRelativePath(file) {
  return path.relative(PROJECT_ROOT, file).split(path.sep).join("/");
}

export function medianWeight(values) {
  const sorted = [...values].sort((left, right) => left - right);
  if (sorted.length === 0) return 1;
  return Math.max(1, Math.round(sorted[Math.floor((sorted.length - 1) / 2)]));
}

// Expected cost of each test file, in milliseconds measured by
// scripts/measure-test-durations.mjs. Only ratios matter.
export function parseShardWeights(text) {
  let table;
  try {
    table = JSON.parse(text);
  } catch {
    throw new TypeError("The test shard weights are not valid JSON.");
  }
  const isWeight = (value) => Number.isSafeInteger(value) && value > 0;
  if (table === null || typeof table !== "object" || table.schema !== SHARD_WEIGHTS_SCHEMA
    || !isWeight(table.defaultWeight)
    || table.files === null || typeof table.files !== "object" || Array.isArray(table.files)
    || !Object.values(table.files).every(isWeight)) {
    throw new TypeError(
      `The test shard weights must declare schema ${SHARD_WEIGHTS_SCHEMA}, a positive integer defaultWeight, and positive integer weights per file.`,
    );
  }
  return { defaultWeight: table.defaultWeight, files: new Map(Object.entries(table.files)) };
}

// Without a weights table, shards fall back to balancing by file size.
export function loadShardWeights(file = SHARD_WEIGHTS_FILE) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  return parseShardWeights(text);
}

let cachedShardWeights;

// Weight of one file: its measured duration; files the table does not know
// (added since the last measurement) count as the median measured file. Every
// shard reads the same checked-out table, so they all derive the same split.
function defaultFileWeight(file) {
  if (cachedShardWeights === undefined) cachedShardWeights = loadShardWeights();
  if (cachedShardWeights === null) return fs.statSync(file).size;
  return cachedShardWeights.files.get(projectRelativePath(file)) ?? cachedShardWeights.defaultWeight;
}

// Deterministic, balanced split: files are placed heaviest first (ties by path)
// on the currently lightest shard (ties by lowest shard index), so the result
// depends only on the file set and its weights. Every file lands in exactly one
// shard; each shard is returned in sorted path order.
export function partitionTestFiles(files, total, fileWeight = defaultFileWeight) {
  const ordered = [...new Set(files)].sort();
  const weighted = ordered
    .map((file) => ({ file, weight: fileWeight(file) }))
    .sort((left, right) => right.weight - left.weight || (left.file < right.file ? -1 : 1));
  const shards = Array.from({ length: total }, () => ({ load: 0, files: [] }));
  for (const { file, weight } of weighted) {
    let target = shards[0];
    for (const shard of shards) {
      if (shard.load < target.load) target = shard;
    }
    target.files.push(file);
    target.load += weight;
  }
  return shards.map((shard) => shard.files.sort());
}

export function selectShardFiles(files, { index, total }, fileWeight = defaultFileWeight) {
  const selected = partitionTestFiles(files, total, fileWeight)[index - 1];
  if (selected.length === 0) {
    throw new Error(
      `Test shard ${index}/${total} has no files; ${files.length} test files cannot fill ${total} shards.`,
    );
  }
  return selected;
}

export function discoverTestFiles(testRoot = TEST_ROOT) {
  const discovered = [];

  function visit(directory) {
    for (const entry of fs.readdirSync(directory, {
      encoding: "utf8",
      withFileTypes: true,
    })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(entryPath);
      } else if (
        entry.isFile()
        && /\.(?:cjs|js|mjs)$/u.test(entry.name)
      ) {
        discovered.push(path.resolve(entryPath));
      }
    }
  }

  visit(testRoot);
  discovered.sort();
  if (discovered.length === 0) {
    throw new Error(`No JavaScript test files were found under ${testRoot}.`);
  }
  return discovered;
}

export async function main({
  env = process.env,
  stdout = process.stdout,
  stderr = process.stderr,
  runTests = run,
  reporter = tap,
  findTestFiles = discoverTestFiles,
  fileWeight = defaultFileWeight,
} = {}) {
  let testStream;
  let streamError;
  let failed = false;
  let completedTestCount = 0;
  let expectedFileCount = 0;

  try {
    const concurrency = parseTestConcurrency(env[TEST_CONCURRENCY_ENV]);
    // Node 20 can otherwise reinterpret this runner script as the only test file.
    // An explicit, non-empty file list keeps discovery stable across Node 18/20/24.
    const shard = parseTestShard(env[TEST_SHARD_ENV]);
    const discovered = findTestFiles();
    const files = shard === null ? discovered : selectShardFiles(discovered, shard, fileWeight);
    if (shard !== null) {
      stdout.write(
        `# test shard ${shard.index}/${shard.total}: ${files.length} of ${discovered.length} test files\n`,
      );
    }
    expectedFileCount = files.length;
    testStream = runTests({ concurrency, files });
    testStream.on("test:pass", () => {
      completedTestCount += 1;
    });
    testStream.on("test:fail", () => {
      completedTestCount += 1;
      failed = true;
    });
    testStream.on("error", (error) => {
      failed = true;
      streamError ||= error;
    });

    for await (const chunk of reporter(testStream)) {
      if (!stdout.write(chunk)) await once(stdout, "drain");
    }
    if (!streamError && completedTestCount < expectedFileCount) {
      failed = true;
      streamError = new Error(
        `Test runner completed only ${completedTestCount} test events for `
        + `${expectedFileCount} explicit test files.`,
      );
    }
  } catch (error) {
    failed = true;
    streamError ||= error;
  }

  if (streamError) {
    stderr.write(`Test runner error: ${formatError(streamError)}\n`);
  }
  return failed ? 1 : 0;
}

function formatError(error) {
  if (error instanceof Error) return error.stack || error.message;
  return String(error);
}

if (path.resolve(process.argv[1] || "") === path.resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = await main();
}
