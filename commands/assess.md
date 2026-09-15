---
description: Contextualize this project and prepare a verified initial assessment.
argument-hint: "[technical|functional|architecture|product] [extra context]"
---

Use the `agentic-sdlc-assessment` skill for this request.

Starter intent: **Contextualize this project and prepare an initial technical assessment.**

Requested focus and extra context: $ARGUMENTS

Rules for this command:

- The plugin root is `${CLAUDE_PLUGIN_ROOT}`. The deterministic CLI is `${CLAUDE_PLUGIN_ROOT}/bin/agentic-sdlc.mjs`; run it with `node`.
- Use `--root` to point at the project being assessed. Never assume the plugin root is the project root.
- Follow the skill's two checkpoints: present the understanding and the proposal first, and persist the assessment artifact only after the proposal is approved.
- Do not declare the human approval yourself. Ask, then wait for the answer in this conversation.
- If no focus is given in `$ARGUMENTS`, propose `technical` and say so.
