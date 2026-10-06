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
- Each story gets its own pull request and autonomy choice. When the user wants one pull request for several parts, propose one delivery story with tasks at breakdown time, before any breakdown is approved.
- Include `.gitignore` in the requirement write paths whenever the work may add or change it.
- `pull_request.create` and `git.push` are authorized actions. They need an approved profile that names them; ask before the first remote-visible action.
- Protected-branch merge, deployment, and production access stay outside this command. After the verified `pull_request.create` completion (and any later `pull_request.update`), close the delivery with `autonomy delivery close --terminal-status ready_for_review` before the lifecycle-complete gate.
- When an active standing approval the user already gave covers this exact kind of pull request (`autonomy standing status`), pass `--standing-approval <id>` instead of asking for the work brief, working-mode, and action confirmations. It never covers merge. If any step answers `checkpoint_required` with `standing_approval.reasons`, stop and ask the user for the normal confirmation. Never create or widen a standing approval without the user's explicit approval.
- If `$ARGUMENTS` is empty, ask for the requirement before touching any record.
