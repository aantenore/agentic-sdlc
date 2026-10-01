#!/usr/bin/env node

import fs from "node:fs";

import { decideDocsOnly } from "../lib/ci/change-scope.mjs";


let decision;
try {
  decision = decideDocsOnly({ env: process.env });
} catch {
  decision = { docsOnly: false, reason: "the change scope could not be evaluated" };
}

const line = `docs_only=${decision.docsOnly ? "true" : "false"}`;
process.stdout.write(`${line} (${decision.reason})\n`);
if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${line}\n`);
