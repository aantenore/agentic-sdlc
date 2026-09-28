"use strict";

const childProcess = require("node:child_process");
const path = require("node:path");

const invoked = path.basename(process.argv0 || process.execPath).toLowerCase();
const provider = process.env.AUTONOMY_FAKE_PROVIDER;

if (provider === "git" && ["git", "git.exe"].includes(invoked)) {
  const cwdOption = process.execArgv.indexOf("-C");
  const cwd = cwdOption >= 0 ? process.execArgv[cwdOption + 1] : null;
  const command = path.basename(process.argv[1] || "");
  const args = [
    ...(cwd ? ["-C", cwd] : []),
    command,
    ...process.argv.slice(2),
  ];
  const commandIndex = args.indexOf("ls-remote");
  if (commandIndex >= 0) {
    const sha = process.env.AUTONOMY_FAKE_REMOTE_SHA || "";
    const refs = args.slice(commandIndex + 3);
    if (sha) process.stdout.write(refs.map((ref) => `${sha}\t${ref}\n`).join(""));
    process.exit(0);
  }

  const result = childProcess.spawnSync(process.env.AUTONOMY_REAL_GIT, args, { stdio: "inherit" });
  if (result.error) process.stderr.write(`${result.error.message}\n`);
  process.exit(result.status ?? 1);
}

if (provider === "gh" && ["gh", "gh.exe"].includes(invoked)) {
  const state = process.env.AUTONOMY_FAKE_GH_STATE;
  const response = {
    url: process.env.AUTONOMY_FAKE_GH_URL,
    state,
    isDraft: process.env.AUTONOMY_FAKE_GH_DRAFT === "true",
    headRefOid: process.env.AUTONOMY_FAKE_GH_HEAD_SHA,
    headRefName: process.env.AUTONOMY_FAKE_GH_HEAD,
    baseRefName: process.env.AUTONOMY_FAKE_GH_BASE,
    baseRefOid: process.env.AUTONOMY_FAKE_GH_BASE_SHA,
    mergedAt: state === "MERGED" ? process.env.AUTONOMY_FAKE_GH_MERGED_AT : null,
    mergeCommit: state === "MERGED" ? { oid: process.env.AUTONOMY_FAKE_GH_MERGE_SHA } : null,
    updatedAt: process.env.AUTONOMY_FAKE_GH_UPDATED_AT || null,
  };
  process.stdout.write(JSON.stringify(response));
  process.exit(0);
}
