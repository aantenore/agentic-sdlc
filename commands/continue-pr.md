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
- Bind the work to the existing head branch recorded in the delivery execution profile. If no profile covers this pull request, propose one with `autonomy delivery propose --kind pull_request --pr-mode existing --pr-number <n> --pr-url <url>` (add `--pr-head-sha <sha>` when the local head branch cannot supply the reviewed head) and get it approved first. That pins the exact PR and reviewed head so the CLI refuses another PR or an unrelated history.
- When you propose that profile, ask the code review question at the same step as the autonomy choice and before `task start`, with the exact Italian or English copy in the skill (Workflow step 13): does the user want a person who did not author the commits to approve the code before this PR is merged? Suggest “No”, and “Yes” when the story touches security, authentication, payments, data migrations, public APIs, or infrastructure. Pass the answer with `--code-review required|not-required --code-review-actor-type human --code-review-approval-source explicit-user --code-review-summary "<the user's words>"`. Never infer it, reuse an earlier answer, or answer for the user, and do not start the task without it. The review is checked only at merge. An existing profile approved before this question has no answer and follows the project default.
- Ask the merge question at the same step with the exact copy in the skill (Workflow step 13): `manual`, `after-confirmation`, or `automatic` (needs `--merge-allowed`, not allowed at level `supervised`). Pass the answer with `--merge manual|after-confirmation|automatic --merge-actor-type human --merge-approval-source explicit-user --merge-summary "<the user's words>"`. Never infer it, reuse an earlier answer, or answer for the user. It is stored as `pull_request_target.merge_decision`.
- Re-run the verification that the contract requires, and link the produced outputs before claiming the update is complete.
- Refresh the checks table in the pull-request description before `pull_request.update`: print it with `autonomy delivery checks --id <profile-id>` once the new evidence is recorded and include it unchanged. The `pull_request.update` authorization returns the same table as `pull_request_body_checks.markdown`.
- After the verified `pull_request.update` completion, close the delivery with `autonomy delivery close --terminal-status ready_for_review` before the lifecycle-complete gate; merge stays outside this command. If the user merged the pull request on GitHub themselves, give them `autonomy delivery reconcile --id <profile-id> --pr-url <url> --actor-type human --approval-source explicit-user --summary "<their words>"` to run in their own terminal; never run it for them.
- If `$ARGUMENTS` does not identify a pull request, ask for it before touching any record.
