---
name: change-observatory
description: Open the Change Observatory bundled with this Agentic SDLC plugin in Codex or Claude Code to inspect a project's recorded requests, decisions, contracts, changes, tests, gates, and lineage. Use when the user asks to open, launch, show, inspect, or explain the visual SDLC history or project change observatory.
---

# Change Observatory

Launch the plugin-local, read-only visual lineage application for the selected project. The application runs only on `127.0.0.1`, uses an ephemeral per-run access token, and never requires a frontend build or cloud service.

## Launch

1. Resolve the absolute path of this `SKILL.md`. The plugin root is exactly two directories above it.
2. Select the target project root from the active workspace or the explicit path supplied by the user.
3. Run the plugin-local entry point; never rely on a global `agentic-sdlc` command or mutate `PATH`:

   ```text
   node <plugin-root>/bin/agentic-sdlc.mjs observe --root <target-project>
   ```

4. Keep the process attached to a managed terminal session. Report the ready URL exactly as emitted. The URL fragment carries the per-run token; do not extract, repeat, or persist the token separately.
5. If browser opening is unavailable or the user wants automation, add `--no-open --json`, wait for the `observatory.ready` line, and present its `url`.

## Boundaries

- Treat the application as local read-only inspection. Do not edit `.sdlc` files to make the display look complete.
- Do not expose it on `0.0.0.0`, another interface, a tunnel, or a public URL.
- Do not add dependencies, start a hosted service, or copy UI assets outside the installed plugin.
- If launch fails, run the plugin-local `doctor --root <target-project>` and report the failing check.
- Stop the managed process with `SIGTERM` when the user asks to close it or when the task no longer needs it.

## Interpretation

Explain only what canonical records support. Generated explanations are labeled and limited to recorded evidence; they are not private chain-of-thought. Call out `missing`, `malformed`, `inferred`, or blocked states instead of inventing history.

Treat IntentABI observations as content-free, advisory shadow evidence. A story
link exists only when a trace explicitly cites the observation path and records
`story_id`. `MAC present / not verified` is not semantic equivalence, cache
admission, token savings, transformed-input authorization, or an SDLC
verification result.
