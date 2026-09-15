---
description: Open the local Change Observatory and explain this project's recorded delivery lineage.
argument-hint: "[project path]"
allowed-tools: Bash(node:*)
---

Use the `change-observatory` skill for this request.

Starter intent: **Open the Change Observatory and explain this project's recorded delivery lineage.**

Project path (optional): $ARGUMENTS

Rules for this command:

- Launch it with the bundled CLI:

  ```bash
  node "${CLAUDE_PLUGIN_ROOT}/bin/agentic-sdlc.mjs" observe --root <project-root> --json
  ```

- Use the current working directory as `<project-root>` when `$ARGUMENTS` is empty.
- The server binds to loopback and issues a single-run bearer token in the returned URL fragment. Give the user the full returned URL; never rewrite or truncate the fragment.
- Add `--no-open` when the user does not want a browser window opened for them.
- Read the recorded lineage and explain it in plain language: what was asked, what was decided, what changed, and what was verified. Do not infer anything the records do not contain.
