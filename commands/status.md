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
- If the output includes a tool suggestion, add it after the next step in one plain sentence: it only names installed tools that fit the work, and it approves, binds, and installs nothing.
- `status` first brings the clone up to date as `orchestration_policy.status_sync.mode` says (`off`, `fetch` by default, or `pull`, which only fast-forwards a branch with no local commits ahead). `--sync off|fetch|pull` overrides it for one run. If the remote cannot be reached, it only warns; say so.
- If the output starts with an "Attention" line (the copy is behind its upstream, or the remote cannot be reached), say first that the counts may be out of date and suggest `git pull`.
- Name the work, not only the counts: the stories ready to start, each blocked story with what blocks it, and the records the agent refreshes itself (with their command; no approval needed).
- If the output lists a story merged but still open (`merged_but_open`), tell the user which story looks merged and at which commit, and that its record still shows it open; status never closes it.
- If the output lists a pull request merged outside the plugin (`merged_outside_plugin`), tell the user plainly that the plugin did not do that merge, and give the `autonomy delivery reconcile` command it prints for them to run in their own terminal. Never run it yourself.
- Add `--json` only when the output feeds another tool.
