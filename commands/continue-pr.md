---
description: Continue an existing pull request, verify the requested changes, and update it without opening a new one.
argument-hint: "<PR number or URL> [what to change]"
---

Use the `agentic-sdlc` skill for this request.

Starter intent: **Continue this existing pull request, verify the requested changes, and update the PR without creating a new one.**

Pull request and requested changes: $ARGUMENTS

Rules for this command:

- The plugin root is `${CLAUDE_PLUGIN_ROOT}`. The deterministic CLI is `${CLAUDE_PLUGIN_ROOT}/bin/agentic-sdlc.mjs`; run it with `node` and pass `--root` for the target project.
- The delivery kind is `pull_request` and the allowed action is `pull_request.update`. Do not request or use `pull_request.create`.
- Bind the work to the existing head branch recorded in the delivery execution profile. If no profile covers this pull request, propose one and get it approved first.
- Re-run the verification that the contract requires, and link the produced outputs before claiming the update is complete.
- If `$ARGUMENTS` does not identify a pull request, ask for it before touching any record.
