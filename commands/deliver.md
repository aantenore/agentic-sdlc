---
description: Turn a requirement into an agreed work brief, implement it, verify it, and open a new pull request.
argument-hint: "<the requirement in plain language>"
---

Use the `agentic-sdlc` skill for this request.

Starter intent: **Turn this new requirement into an agreed work brief, implement it, verify it, and open a new pull request.**

Requirement: $ARGUMENTS

Rules for this command:

- The plugin root is `${CLAUDE_PLUGIN_ROOT}`. The deterministic CLI is `${CLAUDE_PLUGIN_ROOT}/bin/agentic-sdlc.mjs`; run it with `node` and pass `--root` for the target project.
- Follow the skill's `Required Delivery Order`. Do not skip a stage because it looks obvious.
- The delivery kind is `pull_request`. A prior pull-request choice is never reused: propose a delivery execution profile for this delivery and get it approved.
- `pull_request.create` and `git.push` are authorized actions. They need an approved profile that names them; ask before the first remote-visible action.
- Protected-branch merge, deployment, and production access stay outside this command.
- If `$ARGUMENTS` is empty, ask for the requirement before touching any record.
