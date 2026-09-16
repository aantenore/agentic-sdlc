---
description: Check the local Agentic SDLC setup and explain how to fix what is broken.
argument-hint: "[project path]"
allowed-tools: Bash(node:*)
---

Run the bundled diagnostic and explain the result.

Project path (optional): $ARGUMENTS

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/agentic-sdlc.mjs" doctor --root <project-root>
```

Rules for this command:

- Omit `--root` to check the installation only. Pass it to also check an initialized project's knowledge base and output registry.
- A failed check exits non-zero. Report only the failing checks and the concrete fix, not the full pass list.
- The Node runtime requirement is 18.20.3-18.x, 20.12.0-20.x, or 21.6.0+. Earlier releases in those lines contain an upstream native shutdown livelock.
