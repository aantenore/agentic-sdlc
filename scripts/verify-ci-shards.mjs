#!/usr/bin/env node

import { CiGateError, createGithubJsonFetcher } from "../lib/release/ci-gate.mjs";
import { CiShardError, verifyShards } from "../lib/release/ci-shards.mjs";


function parseArgs(argv) {
  const options = { requireExecuted: false };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === "--require-executed") {
      options.requireExecuted = true;
    } else if (/^--(platform|node|shards)$/u.test(key) && argv[index + 1] !== undefined) {
      index += 1;
      options[key.slice(2)] = argv[index];
    } else {
      throw new CiShardError(`unexpected argument ${JSON.stringify(key)}`);
    }
  }
  return options;
}


async function main(argv, env) {
  const { platform, node, shards, requireExecuted } = parseArgs(argv);
  const fetchJson = createGithubJsonFetcher({
    apiUrl: env.GITHUB_API_URL || undefined,
    token: env.GITHUB_TOKEN,
  });
  const total = /^[1-9][0-9]*$/u.test(shards ?? "") ? Number(shards) : NaN;
  const { checked } = await verifyShards({
    fetchJson,
    repository: env.GITHUB_REPOSITORY,
    runId: env.GITHUB_RUN_ID,
    platform,
    node,
    total,
    requireExecuted,
  });
  process.stdout.write(`All ${checked} test shards for ${platform} on Node ${node} ${requireExecuted ? "ran the suite and " : ""}succeeded.\n`);
}


main(process.argv.slice(2), process.env).catch((error) => {
  const known = error instanceof CiShardError || error instanceof CiGateError;
  const message = known
    ? error.message
    : "unexpected error";
  process.stderr.write(`Shard verification failed: ${message}\n`);
  process.exitCode = 1;
});
