---
description: Build and verify a result only on this machine, with no push, pull request, deploy, or production access.
argument-hint: "<what to build or change locally>"
---

Use the `agentic-sdlc` skill for this request.

Starter intent: **Build and verify this result only on my local machine. Do not push, open a pull request, deploy, or use production.**

Requested local result: $ARGUMENTS

Rules for this command:

- The plugin root is `${CLAUDE_PLUGIN_ROOT}`. The deterministic CLI is `${CLAUDE_PLUGIN_ROOT}/bin/agentic-sdlc.mjs`; run it with `node` and pass `--root` for the target project.
- The delivery kind is `local_release`. The approved profile must record the target root, smoke tests, the governed smoke working directory, rollback, write paths, and allowed actions.
- Never request `git.push`, `pull_request.create`, `pull_request.update`, or `pull_request.merge` under this command.
- Treat any request to publish or deploy as a separate decision that this command does not cover. Say so instead of widening the profile.
- If `$ARGUMENTS` is empty, ask what the local result should be before touching any record.
