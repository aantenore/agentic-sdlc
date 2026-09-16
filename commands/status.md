---
description: Show the current lifecycle outcome, the decision waiting on a person, and the next step.
argument-hint: "[project path]"
allowed-tools: Bash(node:*)
---

Run the deterministic status command and explain the result.

Project path (optional): $ARGUMENTS

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/agentic-sdlc.mjs" status --root <project-root>
```

Rules for this command:

- Use the current working directory as `<project-root>` when `$ARGUMENTS` is empty.
- If the project has no `.sdlc` directory yet, say so and offer `init` or `onboard` instead of guessing.
- Report, in this order: the current outcome, what it changes in practice, the decision that needs a person, what stays protected, and the next step.
- Add `--json` only when the output feeds another tool.
