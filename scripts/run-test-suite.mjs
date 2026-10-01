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
const PROJECT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const TEST_ROOT = path.join(PROJECT_ROOT, "test");

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

function defaultFileSize(file) {
  return fs.statSync(file).size;
}

// Deterministic, balanced split: files are placed largest first (ties by path)
// on the currently lightest shard (ties by lowest shard index), so the result
// depends only on the file set and its sizes. Every file lands in exactly one
// shard; each shard is returned in sorted path order.
export function partitionTestFiles(files, total, fileSize = defaultFileSize) {
  const ordered = [...new Set(files)].sort();
  const sized = ordered
    .map((file) => ({ file, size: fileSize(file) }))
    .sort((left, right) => right.size - left.size || (left.file < right.file ? -1 : 1));
  const shards = Array.from({ length: total }, () => ({ load: 0, files: [] }));
  for (const { file, size } of sized) {
    let target = shards[0];
    for (const shard of shards) {
      if (shard.load < target.load) target = shard;
    }
    target.files.push(file);
    target.load += size;
  }
  return shards.map((shard) => shard.files.sort());
}

export function selectShardFiles(files, { index, total }, fileSize = defaultFileSize) {
  const selected = partitionTestFiles(files, total, fileSize)[index - 1];
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
  fileSize = defaultFileSize,
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
    const files = shard === null ? discovered : selectShardFiles(discovered, shard, fileSize);
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
