---
name: agentic-sdlc
description: Use this skill when a user wants to run a contract-driven agentic SDLC in Codex or Claude Code, initialize or maintain a shared project knowledge base, create SDLC phase contracts, split work into story-scoped parallel tracks, validate gates, capture decisions/tests/traces, or use the Agentic SDLC plugin in a software project.
---

# Agentic SDLC

## Purpose

Use this skill to operate a stateless, contract-driven SDLC for a target project. The plugin contains process templates, schemas, and CLI automation; all requirements, execution profiles, contracts, output contracts, traces, and knowledge base artifacts must be saved inside the target project's `.sdlc/` directory.

For a request to contextualize an existing project and produce a technical, functional, architecture, or product assessment, load `../agentic-sdlc-assessment/SKILL.md` and follow that dedicated journey. It is the product entry point for assessments and has exactly two normal plain-language checkpoints. The assessment proposal, budget, contract draft, route intent, write-set, and verification plan form one hash-bound execution tranche. Do not expand it into separate capability, template, contract, budget, and start questions.

## Core Rule

Never store project contracts or project KB state inside the plugin installation. Treat the plugin as reusable method code only. Treat `<target-project>/.sdlc/` as the project source of truth. Treat `<target-project>/.sdlc/cache/` and `<target-project>/.sdlc/indexes/` as derived local optimization artifacts, never as canonical evidence.

## Novice Front Door

Users do not need to know the CLI command tree or the names of internal records. Recognize outcome-oriented requests such as:

- “Turn this new requirement into an agreed work brief, implement it, verify it, and open a new pull request.”
- “Continue this existing pull request, verify the requested changes, and update the PR without creating a new one.”
- “Build and verify this result only on my local machine. Do not push, open a pull request, deploy, or use production.”

Translate those requests into the governed workflow internally. In the primary conversation say “requirement”, “success criteria”, “work brief”, “working mode”, “new pull request”, “existing pull request”, or “local result”. Put route intent, record IDs, hashes, receipts, policy labels, and CLI commands under optional technical details.

Keep these boundaries distinct:

- **Codex conversation**: Codex understands the request, inspects evidence, explains choices, and prepares structured input.
- **Deterministic CLI**: the CLI validates the agreed records and performs deterministic state transitions; it does not interpret the user's prose.
- **Local execution and data**: project reads, approved local writes, tests, `.sdlc/` evidence, and local releases stay on the named machine and paths.
- **Repository publication**: Git push and pull-request create or update are network operations for one named repository and branches.
- **Deployment or production**: never follows from a pull request or local release; it needs a separate exact decision and target.

### Required Delivery Order

For generic implementation and release work, follow this order:

1. **Preview and normalize the request** — identify the intended outcome, target project, delivery destination, evidence boundary, and missing information. This is read-only planning. Do not call `task start`.
2. **Agree the requirement** — show the outcome, success criteria, non-goals, constraints, integrations, and maximum working independence in ordinary language; obtain the required approval.
3. **Decompose only when needed** — propose stories and dependencies for work that cannot safely remain one bounded story; obtain approval before treating the breakdown as canonical.
4. **Agree the output and work brief** — resolve the real output, tools, files, tests, contract, branches or local target, verification, and protected actions. Create and approve the contextualized contract only after this content is complete.
5. **Choose autonomy for this delivery** — for every pull request or local release, ask again; never carry the choice over from earlier work. Before presenting the choices, explain whether option 3 can actually be effective; when this installation cannot digitally verify the approver, say that option 3 will be reduced to “Autonomy with checkpoints”.
6. **Start the story workflow, then start once** — bind the exact configured phase order to the story before any completed step, then make one logical `task start` decision. Never use an early speculative start as routing or discovery, and never reconstruct the workflow after work has begun.
7. **Implement, test, and advance phases** — after the governed task start is recorded, claim the story, change only approved paths, run the agreed checks, record evidence, complete each phase, and enter the next phase only after the previous one is complete.
8. **Validate, then enter release** — after validation and the latest passing test evidence, seal the intermediate strict receipt and use it to move the task-bound workflow into `release`.
9. **Finish and certify at the named destination** — only after entering `release`, create/update and verify the one pull request or complete the local release, record release evidence, complete the release step, release the completed story claim, and run the distinct lifecycle-complete gate. Push, protected-branch merge, remote deployment, and production remain separate when they were not explicitly included.

For a **new pull request**, the displayed boundary must include the repository, base and new head branch, `pull_request.create`, allowed writes, tests, push, and whether later PR updates are included. For an **existing pull request**, resolve and show the exact PR, repository, base, head, current SHA, and allowed update actions; do not create another PR. For a **local-only result**, exclude Git push, pull-request actions, remote deployment, and production access, and require the exact local target, smoke test, and rollback.

The dedicated assessment journey remains the exception described above: it packages its requirement, contract draft, budget, and any already named delivery choice into checkpoint 2, then applies and starts that unchanged proposal without exposing extra normal decisions.

## Workflow

1. Identify the target project root. Default to the current workspace root unless the user names another project.
2. If `.sdlc/project.json` is missing, initialize the project:

   ```bash
   node <plugin-root>/bin/agentic-sdlc.mjs init --root <target-project> --project-name "<name>"
   ```

   When a new project's agreed phase order includes `integration-review`
   between implementation and validation, initialize with the complete
   distributed overlay instead of adding the phase after bootstrap:

   ```bash
   node <plugin-root>/bin/agentic-sdlc.mjs init \
     --root <target-project> \
     --project-name "<name>" \
     --template-dir \
       <plugin-root>/templates/workflow-software-project-v3-integration-review
   ```

   The same `--template-dir` works with `onboard existing-project` when the
   repository has useful code but no `.sdlc/`. It validates and pins the
   seven-phase config and creates its phase contracts in the initial
   bootstrap.

   For an existing repository with useful current code, docs, or configuration, prefer onboarding so the KB starts with an explicit proposed baseline instead of pretending the historical SDLC is known:

   ```bash
   node <plugin-root>/bin/agentic-sdlc.mjs onboard existing-project \
     --root <target-project> \
     --project-name "<name>" \
     --document README.md \
     --question "Which inferred facts are canonical?"
   ```

   Treat `.sdlc/baseline/<id>.json` as proposed until the user explicitly confirms what is canonical. When asking for that confirmation, summarize the baseline contents in chat: inferred project summary, documents read, detected stack, important files, assumptions, and open questions. Do not tell the user to inspect `.sdlc/baseline/<id>.json` or `<id>-current-state.md` manually as the main approval path; links are supporting evidence only.

3. When the user invokes Agentic SDLC for project context, discovery, analysis, design, implementation, validation, release, or other generic phase work, normalize the request into canonical route intent JSON as a read-only preview. Do not call `task start` yet. Explain the intended outcome, delivery destination, known boundaries, and missing decisions in ordinary language. Do not keyword-match inside the CLI. For an assessment, follow the dedicated skill instead: approve the baseline, prepare and approve the immutable combined proposal, apply it idempotently, then make its one proposal-bound start decision. Do not treat natural-language requests such as "initial technical assessment" as permission to analyze directly.

4. Select the SDLC phase: `discovery`, `analysis`, `design`, `implementation`, `validation`, or `release`.
5. Agree the requirement before treating decomposition as canonical. New requirements use `requirement:v2` and move through `propose`, `approve`, `revise`, and `supersede`; `requirement create` is only a compatibility alias for a proposal and must not create approved authority. Capture outcome, acceptance criteria, non-goals, constraints, NFRs, integrations, source hashes, revision lineage, and the linked requirement execution profile. That profile sets an autonomy ceiling and is not an executable grant. A material change creates a new revision and invalidates downstream profiles bound to the prior hash.

   Before proposing implementation work, list every project area that may need a
   durable change, including source, tests, documentation, and evidence.
   Requirement `--write-path` values must resolve inside the project. The CLI
   accepts an internal relative or absolute input but stores a sorted,
   deduplicated Git-relative path; the project root and paths outside it are
   rejected before any proposal is written. An empty requirement scope is
   allowed for governance-only work, but `task start` fails closed before
   preflight for implementation, validation, release, or a contract that names
   durable outputs.

   ```bash
   node <plugin-root>/bin/agentic-sdlc.mjs requirement propose \
     --root <target-project> \
     --id REQ-001 \
     --title "Bounded outcome" \
     --summary "Agreed outcome and material scope" \
     --acceptance "Observable acceptance evidence exists" \
     --write-path src \
     --write-path test \
     --write-path docs \
     --write-path evidence \
     --autonomy-ceiling checkpointed

   node <plugin-root>/bin/agentic-sdlc.mjs requirement approve \
     --root <target-project> \
     --id REQ-001 \
     --actor-type human \
     --approval-source explicit-user \
     --summary "Approve this requirement revision and ceiling"

   node <plugin-root>/bin/agentic-sdlc.mjs autonomy requirement status \
     --root <target-project> \
     --id REQ-001
   ```

   Omitting `--write-path` from `requirement revise` inherits the current
   canonical scope. Supplying one or more values replaces that scope in full;
   restate every path the revision still needs. Approval never rewrites a
   legacy non-canonical proposal: create a new revision first, for example:

   ```bash
   node <plugin-root>/bin/agentic-sdlc.mjs requirement revise \
     --root <target-project> \
     --id REQ-001 \
     --new-id REQ-001-R2 \
     --write-path src \
     --write-path test \
     --write-path docs \
     --write-path evidence
   ```

   Do not confuse this requirement scope with a local-release filesystem
   boundary. Requirement paths are stored relative to the Git project;
   delivery `--target-root`, delivery `--write-path`, and `--smoke-cwd` use
   explicit absolute local paths inside the approved release target.

   After approval, when the requirement needs decomposition, propose a work breakdown and dependency graph, then ask the user to approve or correct it before treating it as canonical:

   ```bash
   node <plugin-root>/bin/agentic-sdlc.mjs breakdown propose --root <target-project> --id BD-REQ-001 --requirement REQ-001 --item story:ST-001
   node <plugin-root>/bin/agentic-sdlc.mjs dependency propose --root <target-project> --id DEP-REQ-001 --edge ST-002:ST-001:requires_artifact:validation:artifact_linked
   ```

6. Before creating a contract, gather project-specific context from `.sdlc/`, user-provided files, repository files, or direct user answers. If critical context, output format, acceptance criteria, delivery target, autonomy choice, or a phase-guiding decision is missing, ask concise questions and stop instead of inventing details or creating a vague contract. Use `--allow-incomplete-contract` only for explicit clarification, migration, or recovery drafts, never to start phase work.
7. Before technical analysis or a contract that depends on project-specific tooling, profile the project/story and propose capability recommendations. Do not keyword-match the user's language. Use repo files, `.sdlc/`, user files, or canonical JSON normalized by Codex:

   ```bash
   node <plugin-root>/bin/agentic-sdlc.mjs capability profile propose \
     --root <target-project> \
     --id CAP-PROFILE-ST-001 \
     --story ST-001 \
     --phase analysis \
     --context-file .sdlc/requirements/REQ-001.json

   node <plugin-root>/bin/agentic-sdlc.mjs capability profile approve \
     --root <target-project> \
     --id CAP-PROFILE-ST-001 \
     --actor-type human \
     --approval-source explicit-user \
     --summary "<user-approved profile>"

   node <plugin-root>/bin/agentic-sdlc.mjs capability recommend \
     --root <target-project> \
     --id CAP-REC-ST-001 \
     --profile CAP-PROFILE-ST-001 \
     --available-capabilities-file .sdlc/decisions/available-capabilities.json
   ```

   Ask for approval before installing missing skills/plugins or using external, write, production, tenant, workspace, endpoint, or secret-bearing targets. When presenting internal capability artifacts, do not teach the SDLC model to the user. Translate them into business/work language: "project evidence and boundaries" means the files, checks, and tool limits I may rely on; "allowed tools for this work" means the concrete tools, permissions, targets, and install decisions I want to use. Explain whether you need more information, whether installs or external access are involved, what approval allows, and what it does not approve. When `capability profile propose` or `capability recommend` returns `assistant_message`, show the business-facing explanation instead of summarizing only IDs. The explanation must be large enough to approve from chat: say what artifact was produced, what is inside it, what decision is needed, and what approval does not cover. If a CLI freshness/hash/stale check appears, do not expose those internal terms as the primary explanation. Say what it means operationally: for example, "I am refreshing the internal reference to the approved tools boundary; this does not change what you approved." Ask again only if the allowed files, tools, installs, external access, output, or work scope changed. Use `capability approve --approve-install` only when that installation approval was explicitly granted.

   Formal SDLC approvals are not implied by a user asking the agent to implement or push. A direct human or CI approval needs host- or CI-issued evidence; an agent-supplied `actor-type human` flag is not authority. By default, a short approval such as "ok", "yes", or "approve" applies only to the immutable subject immediately shown. Assessment checkpoint 2 must create a host approval receipt and proposal-bound content authorization with exact actions, subject hashes, artifact types, use policy, and authority assurance. Every automated use records a validity-at-use receipt. Free-text scope is not an automation credential. A broader delegated scope can cover later artifacts only inside the same immutable delivery unit; it can never supply the required autonomy choice for another pull request or local release. Delegated automation never covers installs, protected-branch merge, remote deploys, secrets, external services, production, destructive actions, or unrelated work unless the exact action and target were explicitly displayed and authoritatively approved. Use bootstrap only for migration/provisional records; it does not satisfy strict gates by default.

8. Decide the contract execution policy and capability policy with the user only when it matters. By default, leave model and reasoning as `inherit`, which means spawned Codex agents reuse the main Codex thread settings. Set `--model`, `--reasoning`, capability policies, capability bindings, or `--capability-recommendation` only when the user asks, the approved capability recommendation says so, or the project KB mandates them.
9. Before creating a phase/story contract that will produce a durable output, resolve the output type. If there is no approved output template for that step/type, propose the template, summarize it to the user using the returned `assistant_message` or `approval requests`, and stop. Do not create a contract that references a draft template and do not produce the phase output until the user agrees the format:

   ```bash
   node <plugin-root>/bin/agentic-sdlc.mjs output resolve --root <target-project> --story ST-001 --type functional-analysis
   node <plugin-root>/bin/agentic-sdlc.mjs output template propose --root <target-project> --type functional-analysis --summary "..."
   node <plugin-root>/bin/agentic-sdlc.mjs approval requests --root <target-project> --story ST-001
   ```

   Every newly created delivery story must include at least one observable
   `--acceptance` criterion before contract/profile setup. If an older story is
   missing criteria, never repair it with `story create --force`: creation is
   intentionally non-overwriting. Before task start, use the additive,
   story-locked recovery command:

   ```bash
   node <plugin-root>/bin/agentic-sdlc.mjs story acceptance add \
     --root <target-project> \
     --id ST-001 \
     --acceptance "<observable story-level success criterion>" \
     --summary "Complete the story definition before task start"
   ```

   This command preserves exact requirement refs, the historical contract
   reference, breakdown links, phase/status, audit origin, plan, and
   implementation log. It refuses terminal, claimed, already-started, or
   partially completed stories and unsafe workspace or trace files. If a
   contract already exists, the changed definition marks it for mandatory
   replacement: create and approve a new contract ID, and use a new delivery
   profile ID when that contract reserves one. Existing active delivery
   profiles remain stale by design and cannot be reused. `task start` stays
   fail-closed until these exact bindings are current. Do not bypass that
   freshness check.

10. Create or locate the story first, then create its final phase contract before doing phase work. It must include enough agreed context, zero unresolved open questions, exact requirement execution profile references, and `--output-ref` for durable story outputs. When delivery work is in scope, reserve a new stable profile ID and store it through `--delivery-profile`; this writes only the planned `delivery_execution_profile_id`, not a delivery-profile hash or approval. Approve the contract before step 13 creates the matching profile against the approved hashes. Never rewrite the approved contract to point back to that profile. A contract or phase override may narrow the effective autonomy level but never widen it.

   Story contract creation auto-populates `story.contract_id`; use `--replace-story-contract` only for explicit renegotiation or recovery. Contract creation is a proposal, not approval to proceed. Summarize the complete contract through `approval requests` and stop until the user explicitly approves, answers, requests changes, or has already granted a broader contract-approval scope that clearly covers it. A broader contract approval never supplies the mandatory autonomy choice for a new delivery unit.

   Show the returned `assistant_message` whenever available: it explains what is being approved, what approval means, and what happens next. When `assistant_message_presentation.translate_to_chat_language` is true, translate and contextualize it in the active chat language while preserving artifact IDs, story IDs, contract IDs, template IDs, file paths, CLI commands, status codes, and schema keys. Keep the primary explanation non-technical and business-facing: say "project context" before baseline, "project evidence and boundaries" before capability profile, "allowed tools for this work" before capability recommendation, "assessment format" before template, and "work brief" before contract. For every prepared artifact, show what it contains, what decision is needed, what is missing, what approval authorizes, and what it does not authorize. Give enough detail for a decision in chat; do not make JSON or Markdown the primary approval flow. Approval scope is single-use and artifact-specific unless the user explicitly grants a broader in-delivery scope. Ask again for every new delivery unit. Do not produce technical/functional analysis, implementation outputs, tests, or release evidence before the contract is approved:

   ```bash
   node <plugin-root>/bin/agentic-sdlc.mjs story create --root <target-project> --id ST-001 --title "..." --requirement REQ-001 --acceptance "<observable story-level success criterion>"
   node <plugin-root>/bin/agentic-sdlc.mjs contract create \
     --root <target-project> \
     --phase <phase> \
     --story ST-001 \
     --context-file .sdlc/requirements/REQ-001.json \
     --context-summary "Project-specific summary" \
     --qa "Who is the target user?|Back-office operators" \
     --capability-recommendation CAP-REC-ST-001 \
     --delivery-profile AUT-PR-184 \
     --output-ref functional-analysis:functional-analysis-v1:new
   node <plugin-root>/bin/agentic-sdlc.mjs approval requests --root <target-project> --story ST-001
   ```

11. Before creating a durable output artifact, resolve the project-wide output contract:

   ```bash
   node <plugin-root>/bin/agentic-sdlc.mjs output resolve --root <target-project> --story ST-001 --type functional-analysis
   ```

   If an approved template exists, use it. If a related story already covers the same requirement, prefer reuse plus delta. If no template exists or the structure must change, propose a template and ask the user to approve it before making it canonical:

   ```bash
   node <plugin-root>/bin/agentic-sdlc.mjs output template propose --root <target-project> --type functional-analysis --summary "..."
   node <plugin-root>/bin/agentic-sdlc.mjs output template approve --root <target-project> --id functional-analysis-v1 --actor-type human --approval-source explicit-user --summary "<user-approved template>"
   ```

12. Confirm how every durable output will link back to story, requirement, approved template, and mode, but do not create or link an implementation/release output before the final contract, delivery profile, and task start are approved. After execution produces the artifact, run `output link` before completing the phase lane. `output link` requires the story contract to be approved and fresh unless `--allow-unapproved-contract-output` is being used for explicit migration/recovery. The CLI records fingerprints, and strict gates fail if the artifact, base artifact, or approved template changes after linking:

   ```bash
   node <plugin-root>/bin/agentic-sdlc.mjs output link \
     --root <target-project> \
     --story ST-001 \
     --type functional-analysis \
     --artifact .sdlc/requirements/functional-analysis.md \
     --template functional-analysis-v1 \
     --mode new \
     --requirement REQ-001
   ```

   `--render-evidence` is reserved for render or visual verification of the
   produced output: a PNG, JPEG, WebP, or PDF render, or a typed
   `render-verification-receipt:v1` JSON file. It is not functional or test
   evidence; record those with `story complete-step` or `trace append`.
   `--evidence` remains accepted by `output link` only as a compatibility
   alias for the same render-only input.

13. Before every delivery, ask for and obtain one fresh working-mode choice. Never inherit, infer, or reuse the choice from an earlier delivery, even when it implements the same approved requirement. First show only the concrete destination, files that may change, actions that remain protected, expiry, and material risks in normal product language. Before listing the choices, state whether the most independent option can actually be effective in this installation; if approver identity cannot be digitally verified, explain that selecting option 3 will produce the effective “Autonomy with checkpoints” mode. Do not lead with internal levels, policy modes, record IDs, hashes, or approval-evidence terminology. A delivery execution profile remains deliberately exact and non-reusable: one story, its one approved contract, and one concrete delivery. If several stories must ship together, agree an aggregation story and contract first.

   For a pull request, ask in the user's language. In Italian, use this copy:

   > Per questa PR, quanto vuoi che lavori in autonomia?
   >
   > 1. Guidato: ti chiedo conferma prima dei passaggi importanti.
   > 2. Autonomia con controlli: procedo da solo, ma mi fermo prima delle azioni delicate concordate.
   > 3. Autonomia completa entro questi limiti: completo questa PR senza pause ordinarie.
   >
   > Questa scelta vale solo per questa PR e non sarà riutilizzata.

   For a local release, use a separate question; never combine the two destinations in one autonomy question:

   > Per questo rilascio locale, quanto vuoi che lavori in autonomia?
   >
   > 1. Guidato: ti chiedo conferma prima dei passaggi importanti.
   > 2. Autonomia con controlli: procedo da solo, ma mi fermo prima delle azioni delicate concordate.
   > 3. Autonomia completa entro questi limiti: completo questo rilascio locale senza pause ordinarie.
   >
   > Questa scelta vale solo per questo rilascio locale e non sarà riutilizzata.

   Map the explicit answer internally only after the plain-language choice: `Guidato` → `supervised`, `Autonomia con controlli` → `checkpointed`, and `Autonomia completa entro questi limiti` → `bounded-autonomous`. The `--level` value is mandatory for every proposal and must come from this delivery's current answer; past choices may inform a recommendation but never supply the value. Keep the complete JSON record for machine processing and place its IDs, codes, hashes, exact actions, and policy calculations only after `Technical details (optional):` or `Dettagli tecnici (facoltativi):`.

   For a new pull request:

   ```bash
   node <plugin-root>/bin/agentic-sdlc.mjs autonomy delivery propose \
     --root <target-project> \
     --id AUT-PR-184 \
     --delivery PR-184 \
     --kind pull_request \
     --story ST-001 \
     --contract contract-ST-001-implementation \
     --requirement REQ-001 \
     --level checkpointed \
     --repository owner/repository \
     --base main \
     --head feature/ST-001 \
     --write-path src \
     --allow-action repository.write \
     --allow-action test.run \
     --allow-action git.commit \
     --allow-action git.push \
     --allow-action pull_request.create \
     --allow-action pull_request.update \
     --json
   ```

   For an existing pull request, resolve and display its exact repository, base, head, current SHA, and PR URL. Omit `pull_request.create`, keep only the approved update actions, and reject a profile that points to a different PR or changed material boundary.

   For a local release:

   ```bash
   node <plugin-root>/bin/agentic-sdlc.mjs autonomy delivery propose \
     --root <target-project> \
     --id AUT-LOCAL-REL-009 \
     --delivery LOCAL-REL-009 \
     --kind local_release \
     --story ST-001 \
     --contract contract-ST-001-release \
     --requirement REQ-001 \
     --level bounded-autonomous \
     --target-root /absolute/project/.local-release \
     --write-path /absolute/project/.local-release/app \
     --allow-action build.local \
     --allow-action test.run \
     --allow-action release.local \
     --smoke-cwd /absolute/project/.local-release/app \
     --smoke-test '["npm","run","smoke:local"]' \
     --rollback "Restore the previous local package and restart the local process" \
     --json
   ```

   A new local `--target-root` may be absent while the delivery is only being
   proposed, reviewed, approved, or started. It must exist as a real,
   non-symlinked directory before `rollback.verify`, `data.migrate`,
   `data.rollback`, or `release.local` is authorized. Govern creation instead
   of running an untracked `mkdir`: after task start, request `build.local`
   without `--confirm-action` first. If and only if the response is
   `checkpoint_required`, show the exact paused decision and repeat the request
   with direct human or CI approval attribution. A non-checkpointed request can
   return its authorization immediately and must not be confirmed a second
   time. Only while executing the resulting exact authorization may the
   external builder create the exact target root, its approved write-path
   children, and the artifact. Then complete `build.local` with immutable
   evidence. The CLI deliberately creates no release directory itself.

   ```bash
   node <plugin-root>/bin/agentic-sdlc.mjs autonomy delivery action \
     --root <target-project> --id AUT-LOCAL-REL-009 \
     --action build.local \
     --json
   ```

   Only when that first response is `checkpoint_required`, repeat it with the
   displayed direct approval:

   ```bash
   node <plugin-root>/bin/agentic-sdlc.mjs autonomy delivery action \
     --root <target-project> --id AUT-LOCAL-REL-009 \
     --action build.local --confirm-action \
     --actor-type human --approval-source explicit-user \
     --summary "Authorize creation and build of this exact local target" \
     --json
   ```

   The external builder may now create only the approved root, children, and
   artifact. Complete the same authorization afterward:

   ```bash
   node <plugin-root>/bin/agentic-sdlc.mjs autonomy delivery action \
     --root <target-project> --id AUT-LOCAL-REL-009 \
     --action build.local --outcome passed \
     --authorization-receipt <AUT-ACT-id-from-build-authorization> \
     --evidence evidence/local-build.json \
     --json
   ```

   When the local delivery changes a data file, add both typed actions and bind
   the reversible boundary at proposal time:

   ```bash
   node <plugin-root>/bin/agentic-sdlc.mjs autonomy delivery propose \
     --root <target-project> \
     --id AUT-LOCAL-DATA-009 \
     --delivery LOCAL-DATA-009 \
     --kind local_release \
     --story ST-001 \
     --contract contract-ST-001-release \
     --requirement REQ-001 \
     --level checkpointed \
     --target-root /absolute/project/local-data \
     --write-path /absolute/project/local-data/app \
     --write-path /absolute/project/local-data/data \
     --smoke-cwd /absolute/project/local-data/app \
     --smoke-test '["npm","run","smoke:local"]' \
     --allow-action data.migrate \
     --allow-action data.rollback \
     --allow-action release.local \
     --data-target /absolute/project/local-data/data/store.json \
     --data-scope 'records[*].schemaVersion' \
     --migration-preview evidence/migration-preview.json \
     --backup-path /absolute/project/local-data/data/store.before.json \
     --rollback "Restore store.json byte-for-byte from store.before.json" \
     --json
   ```

   `data.migrate` and `data.rollback` are always separate checkpoints. The CLI
   never accepts migration shell text or performs the mutation. Authorize the
   exact action, execute it externally, then complete it with immutable
   evidence. The local observer proves target and backup hashes and rejects a
   no-op rollback whose target already matched the backup. For a declared data
   migration, `rollback.verify` binds that exact passing rollback receipt.
   `release.local` cannot even be authorized until the bound rollback
   verification and a later passing migration exist.

   Every new local release also includes `rollback.verify`, even when no data
   migration is declared. Authorize it with immutable rollback-rehearsal
   `--evidence`, then complete it with the exact same evidence. The provider
   binds the local root, write paths, rollback procedure, and evidence hashes
   but executes no command. A passing receipt must exist before
   `release.local`; for data migrations it must bind the exact passing
   `data.rollback` receipt. Missing, changed, or out-of-order evidence blocks
   release before terminal close and also blocks the final lifecycle gate.

   Approve and inspect the exact profile:

   ```bash
   node <plugin-root>/bin/agentic-sdlc.mjs autonomy delivery approve \
     --root <target-project> \
     --id AUT-PR-184 \
     --actor-type human \
     --approval-source explicit-user \
     --summary "Select checkpointed autonomy for PR-184 only"

   node <plugin-root>/bin/agentic-sdlc.mjs autonomy delivery explain \
     --root <target-project> \
     --id AUT-PR-184
   ```

   Before the user chooses, when this installation cannot digitally verify the approver, use this primary explanation in Italian:

   > Questa installazione registra l'approvazione ma non può verificare digitalmente chi l'ha data. Se scegli l'opzione 3, il livello effettivo sarà quindi “Autonomia con controlli”: potrò procedere tra i momenti di revisione concordati, ma non in autonomia completa.

   Only after the optional technical-details divider, explain that `audit_only` narrows requested `bounded-autonomous` to effective `checkpointed`. Explain the practical effect and how to enable verification: a trusted external host or CI issues an Ed25519-signed receipt for the exact delivery-profile approval subject; configure `authority_policy.mode: host_verified` and the matching public key in `authority_policy.trusted_host_keys`, then pass it with `autonomy delivery approve --host-receipt-file <path.json>`. The CLI validates external authority and never mints trusted authority for itself.

   Verify that the approved profile ID equals the planned `delivery_execution_profile_id` in the already approved contract. Before `task start` and before completing any story step, start exactly one current story-bound workflow. The included `software-project` v3 definition is valid only when the project uses its exact six-phase order. If `phase_order` contains, removes, or reorders a phase, propose and approve a story-bound definition with that exact order first; do not force the included preset across a custom configuration:

   ```bash
   node <plugin-root>/bin/agentic-sdlc.mjs workflow instance start \
     --root <target-project> \
     --id DELIVERY-ST-001 \
     --definition software-project \
     --definition-version 3 \
     --story ST-001
   ```

   For a first custom phase, use the complete distributed overlay above. Then
   copy its definition into the target project, edit that project-local copy,
   propose, review, approve, and start it:

   ```bash
   cp \
     <plugin-root>/templates/workflow-software-project-v3-integration-review/workflow-definition.json \
     <target-project>/workflow-software-project-v3-integration-review.json

   node <plugin-root>/bin/agentic-sdlc.mjs workflow definition propose \
     --root <target-project> \
     --id software-project-integration-review \
     --definition-version 1 \
     --definition-file workflow-software-project-v3-integration-review.json

   node <plugin-root>/bin/agentic-sdlc.mjs workflow definition show \
     --root <target-project> \
     --id software-project-integration-review \
     --definition-version 1

   node <plugin-root>/bin/agentic-sdlc.mjs workflow definition approve \
     --root <target-project> \
     --id software-project-integration-review \
     --definition-version 1 \
     --actor-type human \
     --approval-source explicit-user \
     --summary "Approve the displayed seven-phase workflow"

   node <plugin-root>/bin/agentic-sdlc.mjs workflow instance start \
     --root <target-project> \
     --id DELIVERY-ST-001 \
     --definition software-project-integration-review \
     --definition-version 1 \
     --story ST-001
   ```

   The companion `sdlc-config.json` contains the same `integration-review`
   phase and exact `phase_order`. For an untouched plain init with no governed
   work, compare and copy that complete config, then run `config migrate`
   without `--apply` and apply only its displayed `plan_hash`. Do not overwrite
   a customized or active project's full config; merge and review its intended
   config change separately. Never splice the phase into config as an
   undocumented workaround.

   Author-edited definition input is limited to `label`, `description`,
   `initial_state`, `states`, `transitions`, `phase_order`,
   `normal_checkpoints`, and `metadata`. The CLI derives `id`, `version`,
   `kind`, `schema_version`, `status`, `created_at`, `approval`,
   `definition_hash`, and `hash_algorithm`. `--definition-file` accepts only a
   path inside the target project, so never reference the mutable plugin copy
   directly.

   Starting a workflow after a task-start receipt or completed step is deliberately rejected. A legacy task without this pre-task binding may continue, but `--lifecycle-complete` cannot certify it and a post-hoc replay is not a repair.

   Only now make the lifecycle's one logical task-start decision with that profile. Do not use `task start` for preview, routing, requirement discovery, or contract preparation. Task start is automatic only when the effective level is not `supervised` **and** the current phase appears in that level's configured `autonomy_policy.presets.<level>.automatic_phases`. If the CLI requires `--confirm-start`, the explicit confirmation completes this same logical start decision; it does not reopen planning or create a second delivery start. Use `--confirm-start` only after the user confirms this concrete start or with an authorization containing `task.start.confirm`; an agent or system confirmation must cite that grant with `--authorization <id>`. The stock `checkpointed` preset makes analysis, design, implementation, and validation automatic, while keeping release actions checkpointed. Do not rewrite the contract:

   ```bash
   node <plugin-root>/bin/agentic-sdlc.mjs task start \
     --root <target-project> \
     --story ST-001 \
     --delivery-profile AUT-PR-184 \
     --intent-json '<canonical-route-intent-json>' \
     --json
   ```

   The effective level is the minimum of host, project, requirement, delivery, contract, capability, environment, and budget. The profile is non-reusable, permits one concurrent run, and closes when terminal. Protected-branch merge, remote deployment, production access, destructive work, and material drift are explicit exceptions.

   Every state-changing delivery action uses an authorize → execute → complete sequence. In the primary explanation say what operation is paused, its concrete target, what the person must decide, and what remains untouched. Put the internal receipt, canonical action, policy mode, codes, hashes, and command only after the optional technical-details divider. First request an authorization receipt for the exact canonical action and runtime target, and retain the returned `AUT-ACT-...` ID with the external operation. If the command reports `checkpoint_required`, show the plain-language decision and rerun with `--confirm-action` plus formal approval attribution. Under `authority_policy.mode: host_verified`, this rerun must also supply `--host-receipt-file`; the external Ed25519 receipt signs action `autonomy.delivery.action.<canonical-action>` and the exact subject containing the profile, delivery, runtime target, and action details. In `audit_only`, the explicit approval is recorded but does not become host-verified authority. Then execute exactly the recorded operation through the host/tooling. Finally report `--outcome` with immutable evidence and pass `--authorization-receipt <AUT-ACT-id>` whenever more than one authorization for that action is waiting. An identical completion retry is safe and returns the original completion; do not change evidence or operation arguments merely to force a retry. For `git.commit`, bind the exact changed files with repeatable `--scope-path`; for `git.push`, bind the matching remote; for merge, bind the exact PR URL:

   ```bash
   node <plugin-root>/bin/agentic-sdlc.mjs autonomy delivery action \
     --root <target-project> --id AUT-PR-184 \
     --action git.commit --scope-path src/example.mjs --json

   # Execute exactly one non-merge commit whose parent and file set match the receipt.
   node <plugin-root>/bin/agentic-sdlc.mjs autonomy delivery action \
     --root <target-project> --id AUT-PR-184 \
     --action git.commit --outcome passed \
     --authorization-receipt <AUT-ACT-id-from-authorization> \
     --evidence evidence/PR-184-commit.txt --json

   node <plugin-root>/bin/agentic-sdlc.mjs autonomy delivery action \
     --root <target-project> --id AUT-PR-184 \
     --action git.push --remote origin --json
   # Push the exact recorded SHA/ref, collect host or provider evidence, then complete it.
   node <plugin-root>/bin/agentic-sdlc.mjs autonomy delivery action \
     --root <target-project> --id AUT-PR-184 \
     --action git.push --outcome passed \
     --authorization-receipt <AUT-ACT-id-from-authorization> \
     --evidence evidence/PR-184-push.json --json
   ```

   An `authorized` receipt grants only the displayed operation; it does not run it. Push authorization observes the base SHA directly on the selected remote, requires exactly one passing `git.commit` completion for every commit from that SHA to the exact head, and rejects the remote if any configured fetch/push URL identifies another repository. Push/merge authorization records a live remote pre-state, and completion queries the exact Git remote or GitHub PR for the expected post-state after authorization. That observation and the declared evidence are hash-bound, but the observation is not a provider-signed offline attestation; retain durable host/CI/provider evidence and do not call a generic file signed proof. A passing `pull_request.merge` completion or `release.local` completion creates the terminal close receipt automatically; do not manually close either as `merged` or `released`. Other terminal outcomes use `autonomy delivery close` with a formal reason and approval.

   For local release completion, repeat the exact approved shell-free smoke-test argv and rollback. The smoke working directory is governed by `--smoke-cwd`, must be equal to or inside one allowed write path, defaults to the only allowed write path, and is mandatory when several write paths are allowed. Shells, indirect dispatchers, inline interpreter code, and ambiguous loaders are rejected. An explicit interpreted entrypoint must resolve inside an allowed artifact path; package managers may use only `test` or one reviewed `run <script>` from a real, non-symlinked `package.json` in that exact directory. Before spawning, the CLI durably records an attempt that consumes the v3 authorization and binds the plugin build, sandbox, resolved launcher/runtime, explicit payload paths and pre-smoke artifact manifest. It runs from the exact released-artifact directory in a supported read-only sandbox that denies external network, then binds ordered output hashes and an unchanged post-smoke manifest before automatically closing as `released`. macOS denies loopback; Linux `bwrap` provides namespace-local loopback only, so portable smoke must not use listeners or connections. Exercise an exported API handler in-process or validate the artifact without sockets. The runner can read host-account files and is neither a confidentiality sandbox nor a transitive-code-attestation boundary; use reviewed code that does not load ungoverned host paths. Failed/interrupted attempts need a fresh authorization, current v3 receipts cannot downgrade to legacy, and later gates reject released-byte drift. Successful completion currently requires `/usr/bin/sandbox-exec` on macOS or `/usr/bin/bwrap` on Linux; unsupported hosts and Linux without `bwrap` fail closed and remain unreleased.

   Authorize and complete the mandatory rollback rehearsal before asking to authorize `release.local`. For a declared data migration, first complete the initial `data.migrate` and real `data.rollback`; the rollback rehearsal must bind that passing rollback receipt, and a later passing final `data.migrate` must still precede release. In `host_verified` mode, add the exact external `--host-receipt-file` to each checkpoint authorization. In the default `audit_only` mode, omit that option; `--confirm-action` plus direct approval attribution records the checkpoint without claiming verified host authority:

   ```bash
   node <plugin-root>/bin/agentic-sdlc.mjs autonomy delivery action \
     --root <target-project> --id AUT-LOCAL-REL-009 \
     --action rollback.verify \
     --evidence evidence/rollback-rehearsal.json \
     --confirm-action \
     --actor-type human --approval-source explicit-user \
     --summary "Approve this exact rollback rehearsal evidence" \
     --json

   node <plugin-root>/bin/agentic-sdlc.mjs autonomy delivery action \
     --root <target-project> --id AUT-LOCAL-REL-009 \
     --action rollback.verify --outcome passed \
     --evidence evidence/rollback-rehearsal.json \
     --json
   ```

   Only after that passing receipt may the local release be authorized and completed. In the full lifecycle, execute these `release.local` commands only after the validation step passes, the intermediate strict receipt is sealed, and the bound workflow has entered `release`:

   ```bash
   node <plugin-root>/bin/agentic-sdlc.mjs autonomy delivery action \
     --root <target-project> --id AUT-LOCAL-REL-009 \
     --action release.local --confirm-action \
     --actor-type human --approval-source explicit-user \
     --summary "Release this exact local target" \
     --json

   # Perform the approved local write, then let completion run the exact smoke test.
   node <plugin-root>/bin/agentic-sdlc.mjs autonomy delivery action \
     --root <target-project> --id AUT-LOCAL-REL-009 \
     --action release.local --outcome passed \
     --evidence .local-release/release-evidence.json \
     --smoke-cwd /absolute/project/.local-release/app \
     --smoke-test '["npm","run","smoke:local"]' \
     --rollback "Restore the previous local package and restart the local process" \
     --json
   ```

   For implementation work or parallel worker work, inspect the current orchestration state before editing:

   ```bash
   node <plugin-root>/bin/agentic-sdlc.mjs orchestrate status --root <target-project> --json
   ```

14. After the delivery profile is approved and the immutable task-start receipt
   is recorded for the current approved story contract, claim the existing story
   before editing code. A claim is rejected until the story has at least one
   observable acceptance criterion, a current approved contract, and its exact
   task start. Recover an older draft with `story acceptance add` before
   contract creation; if acceptance changes after a contract exists, approve a
   new exact contract and run task start again before claiming. Include
   actor/run/thread attribution when available:

   When a `supervised` delivery checkpoints both `story.claim` and
   `story.complete-step`, create separate directly approved one-use grants.
   Claim authority uses the story subject; completion authority uses the exact
   compound story/step subject:

   ```bash
   node <plugin-root>/bin/agentic-sdlc.mjs authorization grant \
     --root <target-project> \
     --id AUTH-ST-001-CLAIM \
     --scope "Allow one claim for ST-001 only" \
     --allow-use story.claim=ST-001 \
     --max-uses 1 \
     --actor-type human \
     --approval-source explicit-user \
     --summary "Approve one story claim for ST-001"

   node <plugin-root>/bin/agentic-sdlc.mjs authorization grant \
     --root <target-project> \
     --id AUTH-ST-001-DISCOVERY-COMPLETE \
     --scope "Complete discovery for ST-001 only" \
     --allow-use story.complete-step=ST-001.step.discovery \
     --allow-artifact-type discovery-note \
     --max-uses 1 \
     --actor-type human \
     --approval-source explicit-user \
     --summary "Approve the discovery completion for ST-001"
   ```

   Pass `AUTH-ST-001-CLAIM` only to the claim and
   `AUTH-ST-001-DISCOVERY-COMPLETE` only to
   `story complete-step --step discovery`. Create a new grant and compound
   subject for every later step. Story-wide completion grants remain compatible
   for historical records but warn and must not be created for new work. These
   grants do not cover task start, output linking, release, or another step.
   When the effective delivery profile makes a claim, output link, or step
   completion automatic, `--authorization` is optional. If it is nevertheless
   supplied, the CLI treats it as a deliberate tighter approval: it validates
   and consumes the exact action-subject grant or fails the command. It never
   silently ignores the supplied grant. Proposal-bound `output.link` is the
   deliberate exception: it always requires and consumes the proposal-bound
   `output.link` authorization created at proposal approval, even when the
   delivery profile does not configure that action as a checkpoint.
   Replace `discovery-note` with the exact type required by the approved
   contract. Every `--type <type>` passed to `story complete-step` requires the
   same `--allow-artifact-type <type>` on that step's grant; omit it only when
   the completion passes no `--type`.

   ```bash
   node <plugin-root>/bin/agentic-sdlc.mjs story claim --root <target-project> --id ST-001 --agent codex --branch feature/ST-001 --thread-id <thread-id> --authorization AUTH-ST-001-CLAIM
   ```

15. Capture durable autonomy decisions, assumptions, risks, tests, handoffs, sync/push/PR events, dependency revalidation, and release evidence as traces. Include requirement/profile, delivery/profile, requested/effective level, and deterministic reason-code references. Strict gates require `test` and `release` traces to include real evidence paths outside cache/index directories and explicit successful outcomes (`passed` for tests; `ready` or `passed` for release). A local release also requires target-bound smoke-test evidence and its rollback procedure:

   ```bash
   node <plugin-root>/bin/agentic-sdlc.mjs trace append --root <target-project> --story ST-001 --type decision --summary "..." --actor codex --actor-type agent
   node <plugin-root>/bin/agentic-sdlc.mjs trace append --root <target-project> --story ST-001 --type implementation --summary "Codex implemented the requested change" --actor codex --actor-type agent --requested-by antonioantenore --requested-by-type human --request-summary "User-requested change"
   node <plugin-root>/bin/agentic-sdlc.mjs trace append --root <target-project> --story ST-001 --type implementation --summary "Added the requested launcher" --input-summary "Approved contract" --output-summary "Installed launcher" --rationale-summary "Keep evidence local" --alternative "Hosted dashboard" --explanation "The installed plugin now opens recorded project lineage locally." --explanation-kind codex-generated
   node <plugin-root>/bin/agentic-sdlc.mjs trace append --root <target-project> --story ST-001 --type test --outcome passed --summary "Tests passed" --evidence .sdlc/tests/ST-001-test-run.json
   node <plugin-root>/bin/agentic-sdlc.mjs sync record --root <target-project> --story ST-001 --event push --summary "Pushed feature/ST-001"
   ```

   For validation, record test evidence with `test record` instead: it binds the story to the exact executed test command, its exit code, its result counts, and at least one immutable evidence file in a durable `test-run:v1` record. Treat a plain `trace append --type test` entry as the legacy weaker form; the validation gate warns when a story in validation has only that trace and no `test record`:

   ```bash
   node <plugin-root>/bin/agentic-sdlc.mjs test record \
     --root <target-project> \
     --story ST-001 \
     --command '["npm","test"]' \
     --exit-code 0 \
     --passed 42 \
     --evidence .sdlc/tests/ST-001-run.log \
     --framework node:test \
     --summary "Full suite on the reviewed implementation branch"
   ```

   Keep `actor` as the executor. When an agent acts because a human or another system requested it, record `requested_by`; when execution was explicitly authorized, record `authorized_by`. This lets reports answer both "what did Codex execute?" and "what was done on Antonio's request?" without rewriting attribution. Narrative flags are optional; when used, store only shareable summaries derived from recorded evidence. Never put private chain-of-thought, hidden scratch reasoning, or secrets in a trace narrative.

16. When a phase lane is complete, record the step with hashed evidence. `story complete-step` requires the story contract to be approved and fresh unless `--allow-unapproved-contract-output` is being used for explicit migration/recovery. If the step produced a durable artifact, pass `--type` so the CLI verifies the output is linked in the registry:

   ```bash
   node <plugin-root>/bin/agentic-sdlc.mjs story complete-step \
     --root <target-project> \
     --id ST-001 \
     --step functional-analysis \
     --type functional-analysis \
     --summary "Functional analysis accepted for implementation"
   ```

   After each non-terminal phase step is completed, transition the bound workflow to the next configured phase. The completion command seals an exact step-file attestation in the append-only story trace. A current canonical workflow refuses to leave the phase when that step is missing, stale, or manually changed; `workflow instance status` reports the blocker in `current_phase_completion` and keeps `ready_next_states` empty. The ordering is evidence: workflow start must be no later than task start, phase entry must be no later than that phase's completion, and the next phase entry must be no earlier than the previous phase completion:

   ```bash
   node <plugin-root>/bin/agentic-sdlc.mjs workflow instance transition \
     --root <target-project> \
     --id DELIVERY-ST-001 \
     --to <next-configured-phase> \
     --request-id <unique-phase-transition-id>
   ```

17. Use `story prepare-handoff` when passing work between chats, machines, or phases. Use `--release-claim` only when the next agent should be able to claim the story after pulling the shared KB:

   ```bash
   node <plugin-root>/bin/agentic-sdlc.mjs story prepare-handoff \
     --root <target-project> \
     --id ST-001 \
     --to-agent implementation-agent \
     --release-claim \
     --summary "Ready for implementation"
   ```

   Close the handoff when the receiving lane accepts it. Use phase locks only for shared phase artifacts that multiple story lanes could modify.

18. After the validation step and latest passing test evidence, run the ordinary strict story gate. It must validate the requirement revision and ceiling, current non-reused delivery profile, most-restrictive effective level, material-scope freshness, exact authorization uses, and applicable evidence. A passing gate does not itself authorize a release, protected-branch merge, or remote/production deployment:

   ```bash
   node <plugin-root>/bin/agentic-sdlc.mjs gate check --root <target-project> --story ST-001 --strict --out .sdlc/reports/ST-001-gate-report.json
   ```

   This is an intermediate readiness check, not the final delivery certificate. It verifies validation and seals the distinct strict receipt used to move the current story-bound workflow to its configured terminal `release` phase with a unique request ID:

   ```bash
   node <plugin-root>/bin/agentic-sdlc.mjs workflow instance transition \
     --root <target-project> \
     --id <workflow-instance-id> \
     --to release \
     --request-id <unique-release-transition-id>
   ```

   Only after entering `release`, authorize and complete the exact local release or PR delivery, append the passing release trace, and complete the `release` story step. Entry into `release` must precede both the release trace and terminal delivery close. When those results are complete, release the story claim so no active worker can race final certification. Then run the lifecycle-complete gate. It replays the task-bound workflow's immutable instance, event history, checkpoint, audit trace, and alternating phase timeline, and requires every configured phase to have a completed canonical step. Do not claim that the story or discovery-to-release lifecycle is complete unless this stronger command passes and seals its separate final receipt:

   ```bash
   node <plugin-root>/bin/agentic-sdlc.mjs gate check \
     --root <target-project> \
     --story ST-001 \
     --strict \
     --lifecycle-complete \
     --out .sdlc/reports/ST-001-lifecycle-complete.json
   ```

19. Release any remaining phase locks when work is complete or handed off. A completed story claim must already be released before the lifecycle-complete gate in step 18.

20. Rebuild/search the local cache and KB index when context retrieval is needed. For large KBs, rebuild the shared manifest and use non-destructive trace compaction before relying on long raw trace history:

   ```bash
   node <plugin-root>/bin/agentic-sdlc.mjs manifest rebuild --root <target-project>
   node <plugin-root>/bin/agentic-sdlc.mjs trace compact --root <target-project> --story ST-001
   node <plugin-root>/bin/agentic-sdlc.mjs cache rebuild --root <target-project>
   node <plugin-root>/bin/agentic-sdlc.mjs cache status --root <target-project>
   node <plugin-root>/bin/agentic-sdlc.mjs index rebuild --root <target-project>
   node <plugin-root>/bin/agentic-sdlc.mjs kb search --root <target-project> "query"
   ```

   Keep retrieval token-efficient: prefer the human-readable CLI view when it
   contains enough information. JSON from `kb search` and `cache status` is
   compact by default; add `--full` only when the omitted derived payload is
   genuinely needed.

   For supported noisy test, Git, and `rg` commands, use the project-configured
   RTK gateway rather than invoking an assumed global wrapper directly:

   ```bash
   node <plugin-root>/bin/agentic-sdlc.mjs optimization status --root <target-project> --proposal <proposal-id> --json
   node <plugin-root>/bin/agentic-sdlc.mjs optimization run --root <target-project> --proposal <proposal-id> --command-json '["npm","test"]'
   ```

   Add `--exact` for byte-exact or complete output from an already allowlisted
   command. It preserves argv but never allows mutations, external preprocessors,
   unknown executables, or arbitrary diagnostics. The gateway is shell-free and
   applies the configured native fallback only after the active proposal cost
   gate permits new work. A custom provider command requires the invocation-local
   `--trust-custom-rtk-command` switch after its exact argv has been reviewed.

   When `context_optimization_policy.response_provider` selects `caveman`, load
   `../caveman/SKILL.md` for user-facing explanations and status updates. Use
   its configured intensity, but preserve normal wording for approvals,
   irreversible actions, security warnings, exact commands, contracts, and
   durable artifacts. Response compression never creates usage credit:
   thresholds and limits use only usage measured by the selected budget-meter
   adapter after RTK and Caveman have affected the real session.

   In an assessment execution, let the lifecycle capture optimization evidence
   automatically at apply, budget checkpoints, and completion. Use manual
   capture only for an explicit diagnostic:

   ```bash
   node <plugin-root>/bin/agentic-sdlc.mjs optimization capture --root <target-project> --proposal <proposal-id> --phase manual --json
   ```

   Never fabricate lifecycle phases with manual capture. Treat RTK counters as
   project-cumulative and the hash-linked proposal delta as interval-only,
   advisory evidence. RTK always applies zero usage credit and no gate override:
   budget usage comes only from receipts, and soft limits, completion reserve,
   hard limits, and metering violations remain sovereign. A release manifest
   may reference validated optimization observations without changing its
   `budget_decision`.

21. Use activity reports or report queries when the user asks what happened, who changed something, which stories were created, which outputs changed, or similar history questions. For raw natural language, normalize the request into canonical report query JSON first; do not keyword-match the user's language in the CLI. Reports must cite canonical source files and must not infer unstored history:

   ```bash
   node <plugin-root>/bin/agentic-sdlc.mjs report activity --root <target-project> --since 3d --view business --out .sdlc/reports/activity.md
   node <plugin-root>/bin/agentic-sdlc.mjs report query --root <target-project> --query-json '<canonical-report-query-json>' --json
   ```

22. When upgrading an existing KB, migrate only a manifest-defined active release. Run `migration active --release-manifest <id>` first without `--apply`, explain the planned config changes and exact historical evidence set, then apply only after the release manifest and every referenced immutable record validate. The command may add missing configuration defaults and a logical `archive-record:v1`; it must never rewrite approved records or move historical files. Use `archive closed --apply` separately only for an explicitly requested filesystem move.

23. When the user explicitly requests correction of an identity embedded in `.sdlc`, use `migration identity` as a separate recovery class. Run it without `--apply` first. Confirm that legacy/canonical authorization, action-subject, revocation, every prior migration receipt, and supported file-reference lineage validates; the plan has no unsupported records or affected signed envelopes; and the source identity will be absent afterward. Signed evidence must be authoritatively reissued, never rewritten or re-signed by the migration. Apply only with the exact emitted `plan_hash`; any canonical snapshot drift requires a new preview and review. Require its digest-only receipt and rebuilt cache/index state; never use broad text replacement or store the source identity in the receipt. If the journaled shadow-tree swap is interrupted, do not remove or age-reclaim the lock: recover only with the verified lock's `nonce` and `plan_hash`, rolling back before commit or finalizing after commit.

24. When the user asks for a visual explanation of what was requested, changed, decided, or verified, load `../change-observatory/SKILL.md`. It launches the bundled read-only app through the installed plugin-local CLI; do not copy assets, add a build, or depend on global `PATH`.

## References

- Read `references/process.md` when explaining or executing the SDLC phases.
- Read `references/contract-generation.md` before creating or revising contracts.
- Read `references/contracts.md` when creating or reviewing contracts.
- Read `references/knowledge-base.md` when initializing, sharing, or auditing `.sdlc/`.
- Read `references/parallel-work.md` when multiple agents or developers work concurrently.
- Read `references/commands.md` for CLI command details.

## Validation

Before claiming the SDLC is complete or a story is ready to merge:

- verify `.sdlc/project.json` exists in the target project;
- verify existing-project baselines are approved only after explicit user/CI confirmation;
- verify the exact `requirement:v2` revision is approved and its requirement execution profile is active and fresh;
- verify each pull request or local release has its own explicitly approved delivery execution profile;
- verify the effective autonomy is the most restrictive host/project/requirement/delivery/contract/capability/environment/budget result;
- verify `audit_only` never produces `bounded-autonomous` and that the highest level has host/CI assurance;
- verify no delivery profile or authorization was reused for another delivery;
- verify local releases identify target root, writes/actions, successful smoke tests, rollback, and an earlier passing `rollback.verify` receipt bound to unchanged evidence;
- verify declared local data migrations have paired `data.migrate`/`data.rollback`, exact target and scopes, immutable preview evidence, an exact backup, a passing rollback verification, and a later passing final migration before release;
- verify protected-branch merge and remote/production deployment have separate exact authority when requested;
- verify relevant contracts exist under `.sdlc/contracts/`;
- verify durable outputs are linked in `.sdlc/output-contracts/registry.json` with approved templates;
- verify approved breakdowns and dependency graph entries are satisfied when the story uses them;
- verify capability profiles and recommendations referenced by contracts are approved, fresh, and not missing install approvals;
- verify contract capability policies have required bindings or explicit open questions;
- verify story work is under `.sdlc/stories/<story-id>/`;
- verify decisions and evidence are captured in `.sdlc/traces/`;
- verify completed story lanes have step records under `.sdlc/stories/<story-id>/steps/` when work is handed off;
- verify activity reports, manifests, and trace compactions cite canonical source paths and do not use cache/index as evidence;
- verify approvals include `approval_source` and do not treat implementation permission as artifact approval;
- start the exact story-bound workflow before task start, complete each phase before entering the next, use ordinary strict `gate check` after validation, enter `release` before release evidence or terminal delivery, release the completed story claim before final certification, and require `gate check --strict --story <story-id> --lifecycle-complete` before claiming the SDLC complete;
- report any errors or warnings instead of hiding them.
