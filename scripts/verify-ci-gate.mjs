#!/usr/bin/env node

import {
  CI_GATE_POLICY,
  CiGateError,
  createGithubJsonFetcher,
  requiredCiJobNames,
  waitForCiGate,
} from "../lib/release/ci-gate.mjs";


async function main(env) {
  const repository = env.GITHUB_REPOSITORY;
  const sha = env.GITHUB_SHA;
  const fetchJson = createGithubJsonFetcher({
    apiUrl: env.GITHUB_API_URL || undefined,
    token: env.GITHUB_TOKEN,
  });
  process.stdout.write(
    `Requiring a successful ${CI_GATE_POLICY.event} run of ${CI_GATE_POLICY.workflowFile} on ${CI_GATE_POLICY.branch} for ${sha} with ${requiredCiJobNames().length} matrix cells.\n`,
  );
  const verdict = await waitForCiGate({
    fetchJson,
    repository,
    sha,
    log: (message) => process.stdout.write(`${message}\n`),
  });
  process.stdout.write(`CI gate passed: ${verdict.reason}\n`);
}


main(process.env).catch((error) => {
  const known = error instanceof CiGateError;
  process.stderr.write(`CI gate failed (${known ? error.code : "UNEXPECTED"}): ${known ? error.message : "unexpected error"}\n`);
  process.exitCode = 1;
});
