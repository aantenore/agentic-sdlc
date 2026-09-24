# CLI Commands

Run commands with Node from the plugin root:

```bash
node bin/agentic-sdlc.mjs <command>
```

When the command targets another project, pass `--root <target-project>`.

## Initialize

```bash
node bin/agentic-sdlc.mjs init --root <project> --project-name "Product Name"
```

Creates `.sdlc/`, project metadata, KB directories, generated README, and default phase contracts.

For a new seven-phase software project with `integration-review` between
implementation and validation, use the complete distributed template
directory at bootstrap:

```bash
node bin/agentic-sdlc.mjs init \
  --root <project> \
  --project-name "Product Name" \
  --template-dir \
    <plugin-root>/templates/workflow-software-project-v3-integration-review
```

The same `--template-dir` is supported by `onboard existing-project` when
`.sdlc/` does not exist yet. The bootstrap validates and pins the full config
and creates all seven phase contracts.

An exact manifestless project created by the bundled v0.11 format must be
adopted explicitly before its first configuration lock. Preview
`config migrate`, review the identified legacy bootstrap and plan hash, then
apply with:

```bash
node bin/agentic-sdlc.mjs config migrate \
  --root <project> \
  --apply \
  --plan-hash <displayed-sha256> \
  --confirm-legacy-bootstrap \
  --actor-type human \
  --approval-source explicit-user \
  --summary "Adopt this exact legacy bootstrap"
```

CI adoption uses `--actor-type ci --approval-source ci` and still requires a
summary or approval-evidence file. The flag is not accepted for incomplete
newer bootstraps or already locked projects.

For an existing repository, initialize and propose a baseline in one step:

```bash
node bin/agentic-sdlc.mjs onboard existing-project \
  --root <project> \
  --project-name "Product Name" \
  --document README.md \
  --source docs \
  --question "Which inferred facts are canonical?"
```

Summarize `.sdlc/baseline/BASELINE-INITIAL-current-state.md` in chat, including inferred summary, documents read, detected stack, important files, assumptions, and open questions. Do not make the user open the file as the main approval flow. Approve only after explicit confirmation:

```bash
node bin/agentic-sdlc.mjs baseline approve \
  --root <project> \
  --id BASELINE-INITIAL \
  --actor-type human \
  --approval-source explicit-user \
  --summary "Confirmed current-state baseline"
```

## Approval Governance

Approval commands require a formal source. `--actor-type human` alone is not enough.

Use `--approval-source explicit-user` when the user explicitly approves the specific artifact and include `--summary` or `--approval-evidence`. A short "ok" or "yes" applies only to the artifact or decision that was shown immediately before it; do not reuse it for newly created templates, capability profiles, recommendations, contracts, or task start confirmations. Use `--approval-source ci` for approved CI actors. Use `--approval-source bootstrap` only for provisional migration records; bootstrap approvals do not satisfy strict gates by default.

## Agree A Requirement And Its Autonomy Ceiling

New governed requirements use `requirement:v2`. Proposal creation records the requirement and prepares its requirement execution profile; approval binds the immutable revision and its maximum autonomy level. Declare every project area that product work may change, including source, tests, documentation, and evidence. Requirement `--write-path` accepts a project-internal relative or absolute input, then stores the sorted, deduplicated Git-relative form. The project root, paths outside it, and `.git` repository metadata fail atomically. Git commits, pushes, and merges use their explicit delivery actions instead of requirement file-write authority. An empty scope remains valid for governance-only work, but blocks `task start` before preflight for implementation, validation, release, or a contract with durable output references.

```bash
node bin/agentic-sdlc.mjs requirement propose \
  --root <project> \
  --id REQ-001 \
  --title "Bounded outcome" \
  --summary "Agreed outcome and material scope" \
  --acceptance "Observable acceptance evidence exists" \
  --write-path src \
  --write-path test \
  --write-path docs \
  --write-path evidence \
  --autonomy-ceiling checkpointed

node bin/agentic-sdlc.mjs requirement approve \
  --root <project> \
  --id REQ-001 \
  --actor-type human \
  --approval-source explicit-user \
  --summary "Approve requirement REQ-001 and its checkpointed ceiling"

node bin/agentic-sdlc.mjs autonomy requirement status --root <project> --id REQ-001
```

Use immutable revision and supersession commands for material changes. A
revision without `--write-path` inherits the current canonical scope. Supplying
one or more `--write-path` values replaces the scope in full, so include every
path that must remain writable. Approval rejects an old non-canonical proposal
without rewriting it; revise that proposal into a canonical immutable record
first.

```bash
node bin/agentic-sdlc.mjs requirement revise \
  --root <project> \
  --id REQ-001 \
  --new-id REQ-001-R2 \
  --write-path src \
  --write-path test \
  --write-path docs \
  --write-path evidence \
  --autonomy-ceiling supervised

node bin/agentic-sdlc.mjs requirement approve \
  --root <project> \
  --id REQ-001-R2 \
  --actor-type human \
  --approval-source explicit-user \
  --summary "Approve revised requirement REQ-001-R2 and its supervised ceiling"

node bin/agentic-sdlc.mjs requirement supersede \
  --root <project> \
  --id REQ-001 \
  --new-id REQ-001-R2 \
  --reason "Acceptance and integration boundary changed" \
  --actor-type human \
  --approval-source explicit-user \
  --summary "Replace REQ-001 with approved revision REQ-001-R2"
```

Requirement paths above are Git-relative project scope. They are deliberately
different from local-release `--target-root`, `--write-path`, and `--smoke-cwd`
values, which use explicit absolute filesystem paths inside the approved target
as shown later in this reference.

`requirement create` is a compatibility alias for proposal creation, not direct approval. A material revision changes the requirement hash and invalidates downstream delivery profiles bound to the old revision. Legacy `requirement:v1` records remain readable with a conservative `supervised` ceiling.

## Select Autonomy For Every Delivery

Every pull request and every local release needs a new delivery profile ID and an explicit choice among `supervised`, `checkpointed`, and `bounded-autonomous`. Never reuse a profile or approval from another delivery. One profile binds exactly one story and that story's one approved contract. When several stories must ship together, first create an agreed aggregation story/contract; do not use the profile as an unrelated multi-story container.

Create the story, reserve a new profile ID, and create the final contract with that ID. Obtain normal contract approval before proposing the profile. The contract stores only the planned `delivery_execution_profile_id`; the later profile binds the approved requirement-profile, story, and contract hashes.

```bash
node bin/agentic-sdlc.mjs story create --root <project> --id ST-001 --title "Implement REQ-001" --requirement REQ-001 --acceptance "<observable story-level success criterion>"
node bin/agentic-sdlc.mjs contract create \
  --root <project> \
  --phase implementation \
  --story ST-001 \
  --id contract-ST-001-implementation \
  --context-summary "Implement REQ-001 for PR-184" \
  --qa "Which requirement applies?|REQ-001" \
  --delivery-profile AUT-PR-184 \
  --output-ref implementation-summary:implementation-summary-v1:new

node bin/agentic-sdlc.mjs approval requests --root <project> --story ST-001

# Run only after the user explicitly approves the displayed contract.
node bin/agentic-sdlc.mjs contract approve \
  --root <project> \
  --id contract-ST-001-implementation \
  --actor-type human \
  --approval-source explicit-user \
  --summary "Approve the implementation contract for PR-184"
```

Pull-request example:

```bash
node bin/agentic-sdlc.mjs autonomy delivery propose \
  --root <project> \
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
  --allow-action pull_request.update \
  --json
```

Local-release example:

```bash
node bin/agentic-sdlc.mjs autonomy delivery propose \
  --root <project> \
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

The exact `--target-root` may be absent while a new local delivery is only
planned, proposed, approved, or started. Before `rollback.verify`,
`data.migrate`, `data.rollback`, or `release.local` authorization, it must
exist as a real, non-symlinked directory. Create it through the governed build
sequence, not with an untracked setup command: request `build.local` without
`--confirm-action` first. Only if the response is `checkpoint_required`, show
that exact decision and repeat with direct human or CI approval attribution. A
non-checkpointed request returns its authorization directly and must not be
confirmed again. Let the external builder create only the exact approved root,
write-path children, and artifact while executing the resulting authorization,
then complete that same action with immutable evidence. The CLI never creates
release directories.

```bash
node bin/agentic-sdlc.mjs autonomy delivery action \
  --root <project> --id AUT-LOCAL-REL-009 \
  --action build.local
```

Only if that response is `checkpoint_required`, repeat it with the displayed
direct approval:

```bash
node bin/agentic-sdlc.mjs autonomy delivery action \
  --root <project> --id AUT-LOCAL-REL-009 \
  --action build.local --confirm-action \
  --actor-type human --approval-source explicit-user \
  --summary "Authorize creation and build of this exact local target"
```

The external builder may now create only the approved root, children, and
artifact. Complete the same authorization afterward:

```bash
node bin/agentic-sdlc.mjs autonomy delivery action \
  --root <project> --id AUT-LOCAL-REL-009 \
  --action build.local --outcome passed \
  --authorization-receipt <AUT-ACT-id-from-build-authorization> \
  --evidence evidence/local-build.json
```

Approve, inspect, explain, or revoke the exact profile:

```bash
node bin/agentic-sdlc.mjs autonomy delivery approve \
  --root <project> \
  --id AUT-PR-184 \
  --actor-type human \
  --approval-source explicit-user \
  --summary "Select checkpointed autonomy for PR-184 only"

# Effective bounded autonomy only: the external host/CI receipt must sign the
# exact autonomy.delivery.approve subject for AUT-LOCAL-REL-009.
node bin/agentic-sdlc.mjs autonomy delivery approve \
  --root <project> \
  --id AUT-LOCAL-REL-009 \
  --actor-type ci \
  --approval-source ci \
  --host-receipt-file evidence/AUT-LOCAL-REL-009-host-approval.json \
  --summary "CI approves this exact bounded local-release profile"

node bin/agentic-sdlc.mjs autonomy delivery status --root <project> --id AUT-PR-184 --json
node bin/agentic-sdlc.mjs autonomy delivery explain --root <project> --id AUT-PR-184
node bin/agentic-sdlc.mjs autonomy delivery revoke \
  --root <project> \
  --id AUT-PR-184 \
  --reason "PR-184 scope changed" \
  --actor-type human \
  --approval-source explicit-user \
  --summary "Revoke autonomy for PR-184"
```

Before approving, review the complete proposed JSON: requirement ceiling, selected level, target identity, allowed actions, write paths, automatic phases, checkpoints, exception triggers, merge/deploy exclusions, expiry, and the non-reuse boundary. In `audit_only`, a requested `bounded-autonomous` profile evaluates only as `checkpointed`, including for local releases. Effective `bounded-autonomous` requires an external host/CI to sign the exact profile-approval subject with Ed25519, `authority_policy.mode: host_verified`, the public key in `authority_policy.trusted_host_keys`, and `--host-receipt-file <path.json>` on `autonomy delivery approve`. The CLI verifies that receipt; it cannot self-issue trusted authority.

Before task start, verify that the approved profile ID equals the planned `delivery_execution_profile_id` in the already approved contract. Supply that profile to the evaluator. `supervised` always requires confirmation. For another effective level, task start is automatic only when the current phase is listed under `autonomy_policy.presets.<level>.automatic_phases`; otherwise rerun the displayed checkpoint with `--confirm-start` or a matching authorization. The stock `checkpointed` preset makes analysis, design, implementation, and validation automatic but keeps release actions checkpointed. Do not rewrite the contract:

```bash
node bin/agentic-sdlc.mjs task start \
  --root <project> \
  --story ST-001 \
  --delivery-profile AUT-PR-184 \
  --intent-json '<canonical-route-intent-json>' \
  --json
```

The evaluator chooses the most restrictive host, project, requirement, delivery, contract, capability, environment, and budget boundary. A contract may narrow but never widen the result. Pull-request merge to `main` or another protected branch and remote or production deployment remain explicit exceptions. A local release must name its target, writes/actions, shell-free JSON-argv smoke tests, and rollback, and does not imply machine-global, external, production, or destructive access.

## Authorize, Execute, And Complete Delivery Actions

The action command creates a single-use authorization receipt; it does not perform the Git, provider, or local-write operation. Use canonical actions only:

- PR: `repository.read`, `repository.write`, `test.run`, `git.commit`, `git.push`, `pull_request.create`, `pull_request.update`, `pull_request.merge`;
- local release: `build.local`, `test.run`, mandatory non-executing `rollback.verify`, optional paired `data.migrate` and `data.rollback`, then `release.local`.

Ask for the exact action first. A configured checkpoint returns `checkpoint_required` without authority. After showing that exact subject, rerun with `--confirm-action` and formal attribution. When `authority_policy.mode` is `host_verified`, also pass an external `--host-receipt-file`: its Ed25519 signature must bind action `autonomy.delivery.action.<canonical-action>` and the exact profile/delivery/runtime/action-details subject. In `audit_only`, the explicit approval is recorded but cannot be represented as host-verified authority. Then execute the exact recorded operation, collect evidence, and complete the same action:

```bash
# Authorize the exact one-commit transition and file set.
node bin/agentic-sdlc.mjs autonomy delivery action \
  --root <project> --id AUT-PR-184 \
  --action git.commit \
  --scope-path src/example.mjs \
  --json

# Execute exactly one non-merge commit, then report it.
node bin/agentic-sdlc.mjs autonomy delivery action \
  --root <project> --id AUT-PR-184 \
  --action git.commit --outcome passed \
  --authorization-receipt <AUT-ACT-id-from-authorization> \
  --evidence evidence/PR-184-commit.txt \
  --json

# Bind push authorization to one matching remote, source SHA, and destination ref.
node bin/agentic-sdlc.mjs autonomy delivery action \
  --root <project> --id AUT-PR-184 \
  --action git.push --remote origin --json

# Execute that push externally, capture durable host/provider evidence, then complete.
node bin/agentic-sdlc.mjs autonomy delivery action \
  --root <project> --id AUT-PR-184 \
  --action git.push --outcome passed \
  --authorization-receipt <AUT-ACT-id-from-authorization> \
  --evidence evidence/PR-184-push.json --json
```

Keep the returned `AUT-ACT-...` ID beside the host operation. Completion may omit
`--authorization-receipt` only when exactly one matching authorization is still
waiting. If several are waiting, the CLI pauses instead of guessing. Retrying an
identical completion returns the original receipt with `idempotent: true` and
repairs missing trace or close evidence without consuming another authorization.

For every new local release, complete the rollback rehearsal before authorizing
`release.local`. If the profile declares a data migration, first complete the
initial `data.migrate` and real `data.rollback`; `rollback.verify` must bind that
passing rollback receipt, and a later passing final `data.migrate` must still
precede release:

```bash
node bin/agentic-sdlc.mjs autonomy delivery action \
  --root <project> --id AUT-LOCAL-009 \
  --action rollback.verify \
  --evidence evidence/rollback-rehearsal.json \
  --confirm-action \
  --actor-type human \
  --approval-source explicit-user \
  --summary "Approve this exact rollback rehearsal evidence"

node bin/agentic-sdlc.mjs autonomy delivery action \
  --root <project> --id AUT-LOCAL-009 \
  --action rollback.verify \
  --outcome passed \
  --evidence evidence/rollback-rehearsal.json
```

The evidence must be unchanged and outside every approved mutable write path.
The provider observes the exact root, write paths, procedure, and evidence
hashes without running shell or rollback code. In `host_verified` mode, add the
exact external `--host-receipt-file` to the checkpoint authorization. In the
default `audit_only` mode, omit that option; direct approval attribution records
the checkpoint without claiming verified host authority.

For a merge checkpoint, include the exact `--pr-url` when authorizing
`pull_request.merge`. Only after the passing rollback receipt may a local
release authorize `release.local`, perform the approved local writes, and
repeat the exact smoke-test argv and rollback at completion:

```bash
node bin/agentic-sdlc.mjs autonomy delivery action \
  --root <project> --id AUT-LOCAL-REL-009 \
  --action release.local --confirm-action \
  --actor-type human --approval-source explicit-user \
  --summary "Release this exact local target" \
  --json

node bin/agentic-sdlc.mjs autonomy delivery action \
  --root <project> --id AUT-LOCAL-REL-009 \
  --action release.local --outcome passed \
  --evidence .local-release/release-evidence.json \
  --smoke-cwd /absolute/project/.local-release/app \
  --smoke-test '["npm","run","smoke:local"]' \
  --rollback "Restore the previous local package and restart the local process" \
  --json
```

Local completion runs the approved smoke argv without a shell from the exact governed `--smoke-cwd`. Shells, indirect dispatchers, inline interpreter code, and ambiguous loaders are rejected. Explicit interpreted entrypoints must resolve inside an allowed artifact path; package managers may only use `test` or one reviewed `run <script>` from the real package in that directory. Before spawning, a durable write-ahead attempt consumes the v3 authorization and binds the plugin build, sandbox, resolved launcher/runtime, explicit payload paths and pre-smoke artifact manifest. The supported read-only sandbox denies external network; macOS denies loopback and Linux `bwrap` exposes namespace-local loopback only. Portable smoke must not use listeners or connections; API artifacts should expose a handler that the smoke script invokes in-process. The runner can read host-account files and provides neither confidentiality nor transitive-code attestation, so reviewed artifact code must not load ungoverned host paths. Completion records ordered output hashes and an unchanged post-smoke manifest; failed or interrupted attempts require fresh authorization, current v3 receipts cannot downgrade to legacy, and later gates reject artifact drift. The directory must be equal to or inside one allowed write path; it defaults to the only write path and is required when several are allowed. Historical profiles without the field derive it only from one unambiguous write path and otherwise fail closed. Successful completion currently requires `/usr/bin/sandbox-exec` on macOS or `/usr/bin/bwrap` on Linux; unsupported hosts and Linux without `bwrap` fail closed before a `released` receipt is written. Passing `release.local` and `pull_request.merge` completions automatically close the lifecycle as `released` or `merged`; do not also call manual close for those statuses. Use `autonomy delivery close` for formally approved `closed`, `cancelled`, `rolled_back`, `superseded`, or other allowed non-success terminal outcomes.

The CLI revalidates local Git identity, branches, SHA transitions, paths, action receipts, and evidence hashes. Push authorization observes the base SHA directly on the selected remote, requires one passing completed `git.commit` receipt for every commit from that SHA to the exact head, and rejects remotes with any fetch/push URL outside the approved repository. Push/merge authorization records a live remote pre-state, and completion queries the exact Git remote or GitHub PR for the expected later post-state. This observation is not a provider-signed offline attestation; retain durable host/CI/provider evidence and do not claim signed proof when no attestation adapter is configured.

For a reversible local data migration, declare the full boundary while proposing the local release:

```bash
node bin/agentic-sdlc.mjs autonomy delivery propose \
  --root <project> \
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
  --allow-action build.local \
  --allow-action test.run \
  --allow-action data.migrate \
  --allow-action data.rollback \
  --allow-action release.local \
  --data-target /absolute/project/local-data/data/store.json \
  --data-scope 'records[*].schemaVersion' \
  --migration-preview evidence/migration-preview.json \
  --backup-path /absolute/project/local-data/data/store.before.json \
  --rollback "Restore store.json byte-for-byte from store.before.json"
```

Both data actions are checkpoints and use the normal authorize → external execution → complete sequence. `data.migrate` completion proves that the exact backup contains the pre-migration target bytes and that the target changed. `data.rollback` completion proves a real transition from different target bytes back to that exact backup; a no-op is rejected. The CLI accepts no executable or shell option for either action. For a declared data migration, `rollback.verify` must bind that exact passing rollback receipt. `release.local` authorization and completion both require that bound verification plus a later passing migration, so an incomplete sequence cannot terminally close the delivery. The final `--lifecycle-complete` gate revalidates the same receipt chain.

## Create Contract

```bash
node bin/agentic-sdlc.mjs contract create \
  --root <project> \
  --phase design \
  --context-summary "Design the approved workflow into story-scoped delivery units."
```

Creates a contract from `templates/sdlc-config.json`. Normal contract creation requires enough agreed context to guide the phase. If the context, output format, or phase-driving decisions are missing, ask the user first.

Project-specific context can be attached while creating a contract:

```bash
node bin/agentic-sdlc.mjs contract create \
  --root <project> \
  --phase analysis \
  --context-file .sdlc/requirements/REQ-001.json \
  --context-summary "Analyze the MVP around the approved business workflow." \
  --qa "Who approves this phase?|Product owner" \
  --qa "Which external provider is authoritative for MVP?|Provider selected by the approved requirement" \
  --constraint "Provider-specific logic must stay behind an adapter" \
  --output-ref functional-analysis:functional-analysis-v1:new:analysis
```

`--output-ref` uses `type:template:mode[:phase]`. The optional phase must name a phase in the story-bound workflow. The legacy three-part form remains valid and all-due at every strict gate. Phase-scoped references are due cumulatively through the current workflow phase: an intermediate strict gate defers future-phase references, while `--lifecycle-complete` requires all references.

Use `--allow-incomplete-contract` only to persist an explicit clarification, migration, or recovery draft. It is not approval to start phase work. Story contracts automatically update `story.contract_id`; changing a story that already references a different contract requires explicit `--replace-story-contract`.
`output link` and `story complete-step` require an approved, fresh story contract before durable phase output is linked or completed. Use `--allow-unapproved-contract-output` only for explicit migration or recovery of pre-existing artifacts.

By default, the contract execution policy inherits the main Codex thread model and reasoning level. Override them only when needed:

```bash
node bin/agentic-sdlc.mjs contract create \
  --root <project> \
  --phase implementation \
  --model codex-model-id \
  --reasoning high \
  --execution-note "Use higher reasoning for a high-risk architecture change"
```

Supported default reasoning levels are `inherit`, `minimal`, `low`, `medium`, and `high`. Teams can change the allowed levels in `templates/sdlc-config.json`.

Capability policy and bindings can be attached while creating a contract:

```bash
node bin/agentic-sdlc.mjs contract create \
  --root <project> \
  --phase implementation \
  --capability-policy-json '{"mcp":{"required":["repo"],"allowed":[],"forbidden":[]},"skills":{"required":["agentic-sdlc"],"allowed":[],"forbidden":[]},"tools":{"required":[],"allowed":["test-runner"],"forbidden":[]},"approval_required_for":["production_write"]}' \
  --capability-binding-json '{"type":"mcp","name":"repo","binding_id":"repo-main","target":{"repo":"local"},"permissions":["read"]}'
```

Binding files must be canonical project files, never `.sdlc/cache/` or `.sdlc/indexes/`.

Approved capability recommendations can also be applied to a contract. This pulls in the agreed capability policy, bindings, open questions, and model/reasoning suggestions:

```bash
node bin/agentic-sdlc.mjs contract create \
  --root <project> \
  --phase analysis \
  --story ST-001 \
  --context-summary "Technical analysis for the approved workflow." \
  --capability-recommendation CAP-REC-ST-001
```

## Create And Claim Story

```bash
node bin/agentic-sdlc.mjs story create --root <project> --id ST-001 --title "Implement a business workflow" --requirement REQ-001 --acceptance "<observable story-level success criterion>"
node bin/agentic-sdlc.mjs task start --root <project> --story ST-001 --intent-json '<normalized implement_story intent>' --confirm-start --actor-type human
node bin/agentic-sdlc.mjs story claim --root <project> --id ST-001 --agent codex --branch feature/ST-001 --thread-id <codex-thread-id>
node bin/agentic-sdlc.mjs story complete-step --root <project> --id ST-001 --step functional-analysis --type functional-analysis --summary "Functional review complete"
node bin/agentic-sdlc.mjs story prepare-handoff --root <project> --id ST-001 --to-agent implementation-agent --release-claim --summary "Ready for implementation"
node bin/agentic-sdlc.mjs story release --root <project> --id ST-001 --agent codex --reason "Work handed off"
```

For a `supervised` delivery whose exact profile checkpoints both
`story.claim` and `story.complete-step`, use separate one-use delegations. The
claim subject is the story; the completion subject binds the story and exact
configured step:

```bash
node bin/agentic-sdlc.mjs authorization grant \
  --root <project> \
  --id AUTH-ST-001-CLAIM \
  --scope "Allow one claim for ST-001 only" \
  --allow-use story.claim=ST-001 \
  --max-uses 1 \
  --actor-type human \
  --approval-source explicit-user \
  --summary "Approve one story claim for ST-001"

node bin/agentic-sdlc.mjs authorization grant \
  --root <project> \
  --id AUTH-ST-001-DISCOVERY-COMPLETE \
  --scope "Complete discovery for ST-001 only" \
  --allow-use story.complete-step=ST-001.step.discovery \
  --allow-artifact-type discovery-note \
  --max-uses 1 \
  --actor-type human \
  --approval-source explicit-user \
  --summary "Approve the discovery completion for ST-001"

node bin/agentic-sdlc.mjs story claim \
  --root <project> \
  --id ST-001 \
  --agent codex \
  --branch feature/ST-001 \
  --authorization AUTH-ST-001-CLAIM

node bin/agentic-sdlc.mjs story complete-step \
  --root <project> \
  --id ST-001 \
  --step discovery \
  --type discovery-note \
  --summary "The agreed discovery evidence is complete" \
  --authorization AUTH-ST-001-DISCOVERY-COMPLETE
```

The grant is valid only after the exact operations are displayed and approved.
Create a new grant ID and compound subject such as
`ST-001.step.integration-review` for every later completion. Story-wide
completion grants remain readable for compatibility but warn and must not be
created for new work. Neither grant covers the contract, task start, output
link, release, or another step.

At effective levels where a claim, output link, or step completion is
automatic, `--authorization` is optional. Supplying it deliberately tightens
that one operation: the CLI validates and consumes the exact action-subject
grant, or fails without recording the operation. A supplied grant is never
silently ignored. Proposal-bound `output.link` is the exception: it always
requires and consumes the proposal-bound `output.link` authorization created
at proposal approval, even when the delivery profile does not configure that
action as a checkpoint.

Replace `discovery-note` with the exact type required by the approved
contract. Every `--type <type>` passed to `story complete-step` requires the
same `--allow-artifact-type <type>` on that step's grant. Omit the artifact
flag only for a completion with no `--type`.

One story should have one active claim. A story cannot be claimed until it has
at least one observable acceptance criterion, a current approved contract, and
an immutable task-start receipt bound to that exact contract. If acceptance
changes after a contract exists, create and approve a new exact contract, then
run task start again before claiming. Release the claim before another chat
claims the same story, or use `--force` only after human coordination. The CLI
serializes local claim changes and strict gates enforce the configured branch
pattern.

Create every delivery story with at least one observable `--acceptance`
criterion. `story create` never rewrites an existing story. For a legacy story
that is missing criteria, recover only before task start with:

```bash
node bin/agentic-sdlc.mjs story acceptance add \
  --root <project> \
  --id ST-001 \
  --acceptance "<observable story-level success criterion>" \
  --summary "Complete the story definition before task start"
```

The operation is additive and serialized with contract linking and task-start
boundaries. It preserves exact requirement refs, the historical contract
reference, breakdown links, phase/status, audit origin, `plan.md`, and
`implementation-log.md`; it refuses terminal, claimed, already-started, or
partially completed stories and non-regular workspace or trace files. If a
contract already exists, create and approve a new contract ID after the change.
When that contract reserves a delivery profile, use a new profile ID: an active
profile bound to the older story hash is stale by design and is not re-approved
in place. Task start remains blocked until those exact bindings are current;
never use `story create --force` as a recovery shortcut.

`story complete-step` records a completed SDLC lane under `.sdlc/stories/<story-id>/steps/`, appends a trace, requires an approved fresh story contract, and validates linked output artifacts when `--type` is provided. `story prepare-handoff` creates a story handoff package containing story state, claim, completed steps, output links, dependency status, open handoffs, and recent traces. Use `--release-claim` when the receiving chat or developer should be able to claim the story after pulling the KB.

For a current canonical story-bound workflow, `story complete-step` also seals
the exact step-file hash in the append-only story trace. The workflow cannot
leave that phase if the step is absent, predates phase entry, differs from its
sealed attestation, or its trace integrity cannot be verified. Inspect
`workflow instance status`; `current_phase_completion` explains the blocker and
`ready_next_states` remains empty until it is repaired.

## Work Breakdown And Dependencies

```bash
node bin/agentic-sdlc.mjs work item create --root <project> --type epic --id EP-001 --title "Workflow epic" --requirement REQ-001
node bin/agentic-sdlc.mjs work item create --root <project> --type task --id TASK-001 --title "Backend task" --story ST-001
node bin/agentic-sdlc.mjs breakdown propose --root <project> --id BD-REQ-001 --requirement REQ-001 --item epic:EP-001 --item story:ST-001
node bin/agentic-sdlc.mjs breakdown approve --root <project> --id BD-REQ-001 --actor-type human --approval-source explicit-user --summary "Approved breakdown"
node bin/agentic-sdlc.mjs dependency propose --root <project> --id DEP-REQ-001 --edge ST-002:ST-001:requires_artifact:validation:artifact_linked
node bin/agentic-sdlc.mjs dependency approve --root <project> --id DEP-REQ-001 --actor-type human --approval-source explicit-user --summary "Approved dependency graph"
node bin/agentic-sdlc.mjs dependency status --root <project> --story ST-002
node bin/agentic-sdlc.mjs story deps --root <project> --id ST-002
```

Breakdowns and dependencies are proposed first, then approved by a human/CI actor or by delegated automation when the user explicitly gave a matching approval level. Hard dependency scopes block orchestration and strict gates; soft dependencies remain visible as warnings. When upstream artifacts change, record a `dependency.revalidate` trace on downstream stories after review.

## Capability Discovery

```bash
node bin/agentic-sdlc.mjs capability profile propose \
  --root <project> \
  --id CAP-PROFILE-ST-001 \
  --story ST-001 \
  --phase analysis \
  --context-file .sdlc/requirements/REQ-001.json
node bin/agentic-sdlc.mjs capability profile approve --root <project> --id CAP-PROFILE-ST-001 --actor-type human --approval-source explicit-user --summary "Approved capability profile"
node bin/agentic-sdlc.mjs capability recommend \
  --root <project> \
  --id CAP-REC-ST-001 \
  --profile CAP-PROFILE-ST-001 \
  --available-capabilities-file .sdlc/decisions/available-capabilities.json
node bin/agentic-sdlc.mjs capability approve --root <project> --id CAP-REC-ST-001 --actor-type human --approval-source explicit-user --summary "Approved capability recommendation"
node bin/agentic-sdlc.mjs capability status --root <project> --story ST-001 --json
```

Use profile records to capture project/story context, detected stack, constraints, integrations, evidence, source paths, and source hashes. Use recommendation records to capture skills, MCPs, tools, connectors, plugins, models, concrete bindings, decision matrices, open questions, and execution-policy suggestions.

The available-capabilities inventory is optional. Without it, the default
recommendation may use only capabilities proven by the running plugin or
detected local project surface: the Agentic SDLC governance capability itself
and, for a detected Node.js project, the local test runner. Supply an inventory
when recommending additional host skills, tools, connectors, plugins, MCPs, or
models. A default recommendation must not mark the running plugin itself as
unknown and then fail only after delivery approval.

If a recommendation requires installing a missing skill/plugin/connector or using a new external/write/production target, approval is separate:

```bash
node bin/agentic-sdlc.mjs capability approve --root <project> --id CAP-REC-ST-001 --actor-type human --approval-source explicit-user --summary "Approved install" --approve-install
```

Without install approval, the recommendation can be stored but cannot be applied to a contract. Strict gates also fail when a contract references stale or modified capability recommendations.

## Orchestrate Parallel Work

```bash
node bin/agentic-sdlc.mjs orchestrate status --root <project> --json
node bin/agentic-sdlc.mjs orchestrate plan --root <project> --limit 10
```

Use `status` before opening another Codex chat. Use `plan` to find available story lanes for a parent orchestrator chat.

## Route Intent

```bash
node bin/agentic-sdlc.mjs route decide --root <project> --json --intent-json '<canonical-route-intent-json>'
node bin/agentic-sdlc.mjs route --root <project> --json --intent-file .sdlc/requests/ST-001-route-intent.json
node bin/agentic-sdlc.mjs task start --root <project> --json --intent-json '<canonical-route-intent-json>'
```

The route command is deterministic. Codex or another LLM must first normalize the user's request into `schemas/route-intent.schema.json`; the CLI does not classify raw natural language. `--text` can be provided for audit/debug context, but it is ignored for routing. Intent files cannot live under `.sdlc/cache/` or `.sdlc/indexes/`.

Minimum canonical intent:

```json
{
  "requested_action": "implement_story",
  "confidence": 0.92,
  "referenced_entities": [{ "type": "story", "id": "ST-001" }],
  "provided_artifacts": [],
  "missing_context": [],
  "proposed_phase": "implementation",
  "artifact_type": null,
  "skip_phases": []
}
```

The decision output contains the selected route, confidence result, deterministic checks, blocking reasons, questions for the user, and suggested next CLI commands. Low confidence, missing context, phase skips, implementation starts, new templates, duplicate outputs, and missing capability profiles for technical analysis require confirmation or clarification according to `routing_policy`.

Before `task start`, start the story-bound workflow while the story has neither a
task-start receipt nor a completed step:

```bash
node bin/agentic-sdlc.mjs workflow instance start \
  --root <project> \
  --id DELIVERY-ST-001 \
  --definition software-project \
  --definition-version 3 \
  --story ST-001
```

The included v3 definition requires the exact stock six-phase `phase_order`.
Projects with custom phases must use an approved story-bound definition with
the exact configured order. A workflow cannot be added retroactively; a legacy
task without the pre-task binding is not eligible for lifecycle-complete
certification.

For the first common customization, initialize or onboard with the complete
template directory shown above. Then copy its v3-compatible definition into
the target project, edit it, propose and review it, approve that exact version,
then start it:

```bash
cp \
  <plugin-root>/templates/workflow-software-project-v3-integration-review/workflow-definition.json \
  <project>/workflow-software-project-v3-integration-review.json

node bin/agentic-sdlc.mjs workflow definition propose \
  --root <project> \
  --id software-project-integration-review \
  --definition-version 1 \
  --definition-file workflow-software-project-v3-integration-review.json

node bin/agentic-sdlc.mjs workflow definition show \
  --root <project> \
  --id software-project-integration-review \
  --definition-version 1

node bin/agentic-sdlc.mjs workflow definition approve \
  --root <project> \
  --id software-project-integration-review \
  --definition-version 1 \
  --actor-type human \
  --approval-source explicit-user \
  --summary "Approve the displayed seven-phase workflow"

node bin/agentic-sdlc.mjs workflow instance start \
  --root <project> \
  --id DELIVERY-ST-001 \
  --definition software-project-integration-review \
  --definition-version 1 \
  --story ST-001
```

The companion config already contains `integration-review` in `phases`, the
same exact `phase_order`, and the matching autonomy preset entries. If a plain
default init was just completed and no governed work has begun, first compare
the two full configs, copy the companion over `.sdlc/config.json`, preview
`config migrate`, and apply only its displayed plan hash:

```bash
diff -u \
  <project>/.sdlc/config.json \
  <plugin-root>/templates/workflow-software-project-v3-integration-review/sdlc-config.json
cp \
  <plugin-root>/templates/workflow-software-project-v3-integration-review/sdlc-config.json \
  <project>/.sdlc/config.json
node bin/agentic-sdlc.mjs config migrate --root <project>
node bin/agentic-sdlc.mjs config migrate \
  --root <project> \
  --apply \
  --plan-hash <hash-shown-by-the-preview>
```

Do not replace a customized or active project's full config with this
companion. Merge and review its intended change separately.

The editable definition input fields are `label`, `description`,
`initial_state`, `states`, `transitions`, `phase_order`,
`normal_checkpoints`, and `metadata`. The CLI supplies or overrides `id`,
`version`, `kind`, `schema_version`, `status`, `created_at`, `approval`,
`definition_hash`, and `hash_algorithm`. Because `--definition-file` accepts
only a project-internal file, never point it directly at the plugin
installation.

Use `task start` as the operational front door before Codex performs phase work. It runs route decision, finds the applicable story or phase contract, blocks missing/incomplete/unapproved/stale contracts, and returns `ready_to_execute` only when execution is allowed. `--confirm-start` confirms the concrete start of work, but it does not count as formal contract approval. `--revise-contract` deliberately stops for contract revision even when a usable contract exists.

## Handoff And Locks

```bash
node bin/agentic-sdlc.mjs story handoff --root <project> --id ST-001 --to-agent implementation-agent --artifact .sdlc/requirements/functional-analysis.md
node bin/agentic-sdlc.mjs story prepare-handoff --root <project> --id ST-001 --to-agent implementation-agent --release-claim
node bin/agentic-sdlc.mjs story handoff close --root <project> --id HND-ST-001-20260701123000 --status closed
node bin/agentic-sdlc.mjs phase lock --root <project> --phase analysis --reason "Updating shared analysis artifact"
node bin/agentic-sdlc.mjs phase release --root <project> --id LOCK-analysis-20260701123000 --reason "Shared artifact stable"
```

Use phase locks for shared phase artifacts, not for normal story-scoped work. A second active lock for the same phase/scope is rejected unless `--force` is used after coordination.

## Record Test Evidence

Use `test record` as the durable way to bind a story to the exact executed test command, its exit code, its result counts, and at least one immutable evidence file:

```bash
node bin/agentic-sdlc.mjs test record \
  --root <project> \
  --story ST-001 \
  --command '["npm","test"]' \
  --exit-code 0 \
  --passed 42 \
  --evidence .sdlc/tests/ST-001-run.log \
  --framework node:test \
  --summary "Full suite on the reviewed implementation branch"
```

The command is recorded, never run. A story in validation with only a `trace append --type test` entry and no `test-run:v1` record is the legacy weaker form; prefer `test record` for validation evidence and use `trace append --type test` only where a durable test record does not apply.

## Scan Changed Files For Credentials

Use `secret scan` to search the files one delivery changed for credentials and store the result as a `secret-scan:v1` record under `.sdlc/security/`:

```bash
node bin/agentic-sdlc.mjs secret scan --root <project> --story ST-001
node bin/agentic-sdlc.mjs secret scan --root <project> --story ST-001 --base main --head HEAD --json
```

`--base` defaults to the commit the story's task start recorded and `--head` to the current `HEAD`. A story whose work is not committed yet is scanned from the uncommitted workspace, and a local release with neither falls back to the story's approved write paths.

Findings are reported as the rule, the file, the line, and at most four leading characters of the match; the matched value is never printed or stored. A clean scan exits `0` and a scan with findings exits `1`. When `gate_policy.secret_scan.enabled` is `true`, a story in validation needs a record whose outcome is `clean` for the current head. Rules come from `gate_policy.secret_scan.rules` merged over the shipped defaults by `id`, and `gate_policy.secret_scan.exclude_paths` lists path globs to leave out.

## Append Trace

```bash
node bin/agentic-sdlc.mjs trace append --root <project> --story ST-001 --type test --outcome passed --summary "Unit tests passed" --evidence .sdlc/tests/ST-001-test-run.json --actor codex --actor-type agent
node bin/agentic-sdlc.mjs trace append --root <project> --story ST-001 --type implementation --summary "Codex implemented a requested change" --actor codex --actor-type agent --requested-by antonioantenore --requested-by-type human --authorized-by antonioantenore --authorized-by-type human --request-summary "Implement the requested feature"
node bin/agentic-sdlc.mjs trace append --root <project> --story ST-001 --type implementation --summary "Added a local launcher" --input-summary "Approved contract" --output-summary "Installed observe command" --rationale-summary "Keep evidence local" --alternative "Hosted dashboard" --explanation "The plugin can now display recorded delivery lineage locally." --explanation-kind codex-generated
```

Valid trace types: `assumption`, `decision`, `gate`, `claim`, `handoff`, `implementation`, `lock`, `release`, `risk`, `sync`, `test`.
Valid trace outcomes are `passed`, `failed`, `blocked`, `skipped`, and `ready`. Strict validation requires a `test` trace with `passed`; strict release requires `ready` or `passed`.

Narrative flags are optional and repeatable where applicable. `--explanation-kind` accepts `codex-generated`, `deterministic`, or `human-authored` and requires `--explanation`. The stored scope is always `recorded-evidence-only`; never record private chain-of-thought or hidden reasoning.

Record push and merge events explicitly:

```bash
node bin/agentic-sdlc.mjs sync record --root <project> --story ST-001 --event push --remote origin --summary "Pushed feature/ST-001"
```

## Change Observatory

From an npm/git/tarball installation with a bin shim:

```bash
agentic-sdlc observe --root <project>
agentic-sdlc observe --root <project> --host 127.0.0.1 --port 0 --no-open --json
```

From a Codex plugin installation, use the `change-observatory` skill so it resolves `<plugin-root>/bin/agentic-sdlc.mjs` directly. The returned URL contains an ephemeral token in the fragment. Keep the process alive while viewing the app and stop it with `SIGINT` or `SIGTERM`.

## Gate Check

```bash
node bin/agentic-sdlc.mjs gate check --root <project> --story ST-001 --strict --out .sdlc/reports/ST-001-gate-report.json
```

With `--story`, the default scope is story-scoped, so unrelated story lanes do not block each other. Use `--scope all` for project-wide checks. Complete the validation step first. For the current `software-project` v3 definition, this ordinary strict form writes an intermediate `workflow-strict-gate-receipt:v2`. The receipt binds the exact workflow instance, effective definition, durable checkpoint, current phase, and phase order; it cannot be reused after the workflow advances. A workflow pinned to the compatibility v2 definition continues to write and accept the unscoped v1 receipt required by its pinned canonical-evidence v1 contract. A legacy story with no workflow may also retain a readable v1 receipt. Neither form is final, and every canonical guard accepts only the receipt schema pinned by its immutable effective definition. Use the current v2 receipt to move a new v3 workflow to its next guarded phase:

```bash
node bin/agentic-sdlc.mjs workflow instance transition \
  --root <project> \
  --id <workflow-instance-id> \
  --to release \
  --request-id <unique-release-transition-id>
```

Only after that transition, complete the exact delivery, append the passing
release trace, and complete the release story step. The release-phase entry
must be no later than both the release trace and terminal delivery close. Then
certify the completed lifecycle with:

```bash
node bin/agentic-sdlc.mjs gate check \
  --root <project> \
  --story ST-001 \
  --strict \
  --lifecycle-complete \
  --out .sdlc/reports/ST-001-lifecycle-complete.json
```

Do not present an intermediate strict result as the final discovery-to-release certificate. Both forms return non-zero when blocking errors are found. Use `--out` to persist JSON or Markdown gate evidence.

## Output Consistency

```bash
node bin/agentic-sdlc.mjs output template propose --root <project> --type functional-analysis --summary "Standard functional analysis"
node bin/agentic-sdlc.mjs output template approve --root <project> --id functional-analysis-v1 --actor-type human --approval-source explicit-user --summary "Approved output template"
node bin/agentic-sdlc.mjs output resolve --root <project> --story ST-001 --type functional-analysis
node bin/agentic-sdlc.mjs output link \
  --root <project> \
  --story ST-001 \
  --type functional-analysis \
  --artifact .sdlc/requirements/functional-analysis.md \
  --template functional-analysis-v1 \
  --mode new \
  --requirement REQ-001
node bin/agentic-sdlc.mjs output status --root <project> --story ST-001
```

`output resolve` checks the approved template registry and related story links. If another story already covers the same requirement, the expected result is reuse plus delta. `output link` requires an approved fresh story contract, then records the final user-agreed artifact, approved template, mode, requirements, and content fingerprints. Strict gates fail when linked outputs use unapproved or changed templates, create unjustified duplicates, omit requirements, point to cache/index files, or drift after linking.

For a rendered or visual output, pass `--render-evidence <path>` with a PNG,
JPEG, WebP, or PDF render, or with a typed
`render-verification-receipt:v1` JSON file. This option does not accept
functional or test evidence; record those with `story complete-step` or
`trace append`. The older `--evidence` spelling remains accepted by
`output link` only as a compatibility alias for the same render-only input.

When a duplicate new output or structure override is intentionally approved, run `output link` with `--decision-id` and `--rationale` as a human or CI actor. The CLI records the approved decision in the registry:

```bash
node bin/agentic-sdlc.mjs output link \
  --root <project> \
  --story ST-002 \
  --type functional-analysis \
  --artifact .sdlc/requirements/ST-002-functional-analysis.md \
  --template functional-analysis-v1 \
  --mode new \
  --requirement REQ-001 \
  --decision-id DEC-output-override-001 \
  --rationale "User approved a separate artifact because the workflow diverges" \
  --actor-type human \
  --approval-source explicit-user \
  --summary "Approved separate artifact"
```

## Cache, Index, And Search

```bash
node bin/agentic-sdlc.mjs cache rebuild --root <project>
node bin/agentic-sdlc.mjs cache status --root <project>
node bin/agentic-sdlc.mjs cache status --root <project> --json --full
node bin/agentic-sdlc.mjs cache clear --root <project>
node bin/agentic-sdlc.mjs manifest rebuild --root <project>
node bin/agentic-sdlc.mjs trace compact --root <project> --story ST-001
node bin/agentic-sdlc.mjs archive closed --root <project> --before 90d
node bin/agentic-sdlc.mjs migration active --root <project> --release-manifest RELEASE-ASSESSMENT-001
node bin/agentic-sdlc.mjs migration active --root <project> --release-manifest RELEASE-ASSESSMENT-001 --apply
node bin/agentic-sdlc.mjs migration identity --root <project> --identity-map-json '{"source":{"email":"old@example.invalid"},"target":{"email":"new@example.test","name":"Current User"}}'
node bin/agentic-sdlc.mjs migration identity --root <project> --identity-map-json '{"source":{"email":"old@example.invalid"},"target":{"email":"new@example.test","name":"Current User"}}' --apply --plan-hash <preview-plan-hash>
node bin/agentic-sdlc.mjs migration identity --root <project> --recover --recovery-nonce <nonce-from-lock> --plan-hash <hash-from-lock>
node bin/agentic-sdlc.mjs index rebuild --root <project>
node bin/agentic-sdlc.mjs kb search --root <project> "business workflow"
node bin/agentic-sdlc.mjs kb search --root <project> "business workflow" --json --full
```

Cache and indexes are local derived artifacts. They can accelerate context retrieval and output resolution, but canonical requirements, approvals, decisions, tests, traces, and outputs must stay in source-of-truth `.sdlc/` folders.
If a cached output resolution differs from canonical KB files, the CLI rejects it and asks for `cache rebuild`.

JSON is compact by default at the retrieval boundary: `kb search --json` omits
the duplicated full-text field, and `cache status --json` omits the complete
derived cache. Both responses preserve paths and diagnostics and report an
estimated token reduction. Add `--full` only when the omitted derived payload
is required; it never changes canonical evidence. Search limits are bounded to
1-100.

`manifest rebuild` creates a compact, shared KB map under `.sdlc/manifests/`. `trace compact` creates non-destructive summaries under `.sdlc/traces/compactions/`; original JSONL traces remain canonical. `archive closed` writes an archive plan for old reports and compactions and moves files only with `--apply`.

`migration active` is dry-run by default. The release manifest defines the exact active scope; the command validates every referenced immutable record, upgrades only missing configuration defaults on `--apply`, and emits a logical `archive-record:v1` for evidence referenced only by older valid releases. It rewrites no approved record and moves no file.

`migration identity` is also dry-run by default, but it is an explicit lineage-repair workflow rather than an active-release upgrade. It accepts direct `--from-email`/`--to-email` values or a declarative JSON mapping; schema- and hash-validates legacy/canonical authorization, action-subject bindings, revocations, all prior migration receipts, and supported byte references; and computes the transitive subject/scope/authorization/revocation/receipt/file-reference rewrites. Unsupported records, stale supported references, and any directly or transitively affected signed envelope fail closed; signed evidence must be reissued. The preview emits a plan hash bound to the complete canonical input snapshot. `--apply --plan-hash <preview-plan-hash>` rejects drift, then uses a fully initialized no-auto-reclaim project lock and complete-input preconditions to build the entire result in a same-filesystem shadow tree. It rebuilds derived state there, validates it, journals intent before each directory rename, and commits by activating the shadow. Caught failures restore the complete rollback snapshot. An interrupted process is recovered only with `--recover --recovery-nonce <nonce-from-lock> --plan-hash <hash-from-lock>`; pre-commit state rolls back and committed state only finalizes. The immutable receipt keeps rebuild as a conservative required obligation; the apply result reports `rebuilt` only after the callback completes, while the CLI validates cache and index. The receipt stores the plan hash, identity digests, and before/after hashes, never the corrected source email in clear text.

## Context Optimization Gateway

RTK 0.43+ is an optional, separately installed command-output optimizer. Inspect
the configured provider and current telemetry before relying on it:

```bash
node bin/agentic-sdlc.mjs optimization status --root <project> --proposal ASSESS-001 --json
```

Route a supported command as a shell-free argument vector. `auto` selects a
native, test, Git, or `rg` profile; use `--exact` to bypass RTK when complete or
unfiltered output is required. Bind the active proposal so its cost gate is
checked before execution:

```bash
node bin/agentic-sdlc.mjs optimization run --root <project> --proposal ASSESS-001 --command-json '["npm","test"]'
node bin/agentic-sdlc.mjs optimization run --root <project> --command-json '["git","diff","--binary"]' --exact
```

The default native fallback handles an unavailable or unsupported RTK provider
without claiming savings. Unknown commands, mutations, unsafe Git output flags,
external `rg` preprocessors, and executable paths are rejected rather than
treated as fallback. `--exact` bypasses filtering but does not widen this
allowlist or disable `rg --no-config` and Git external-driver suppression.
Custom provider executable/prefix arguments and project-local PATH shadows
require the invocation-local `--trust-custom-rtk-command` switch; a normal PATH
provider is canonicalized and spawned by absolute path. In automatic mode, proposal apply,
budget checkpoints, and completion create lifecycle observations. Use only the
manual phase for operator diagnostics:

```bash
node bin/agentic-sdlc.mjs optimization capture --root <project> --proposal ASSESS-001 --phase manual --json
```

Do not manually label a capture as apply, checkpoint, or complete. RTK counters
are project-cumulative and may contain concurrent checkout activity; the
proposal observation delta covers only the interval since its prior observation
and remains estimated. Both are context-savings telemetry, not provider usage
or billing evidence.

Every observation is advisory-only with `usage_adjustment_applied: 0` and
`gate_override: false`. Budget usage comes exclusively from append-only usage
receipts. Warning, soft-limit, completion-reserve, hard-limit, and
metering-violation decisions remain sovereign, even when the budget status
recommends more aggressive RTK use. Completion may reference validated
observation lineage in the manifest and an optional gate check; it must never
change the manifest's `budget_decision`.

## Default native Codex-session metering

The bundled adapter reads only local `session_meta` and `token_count` events
for the exact `CODEX_THREAD_ID`. It executes no shell and uses no web page,
external API, or authentication. Capture before execution and record
incremental observations with the same persisted task identity:

```bash
node bin/agentic-sdlc.mjs budget meter start --root <project> --proposal ASSESS-001
node bin/agentic-sdlc.mjs budget meter record --root <project> --proposal ASSESS-001
```

Native observations are always `estimated` and `advisory_observed`, with cost
unavailable. They never satisfy exact/hard enforcement or emit an attestation;
mapped hard metrics deliberately produce `metering_violation` after evidence is
recorded. CodeBurn remains disabled-by-default legacy compatibility and must
never be installed or enabled automatically.

## Activity Reports

```bash
node bin/agentic-sdlc.mjs report activity --root <project> --since 3d --view business --out .sdlc/reports/activity.md
node bin/agentic-sdlc.mjs report activity --root <project> --since 3d --view dev --json
node bin/agentic-sdlc.mjs report activity --root <project> --since 12h --view agent-verbose --story ST-001
node bin/agentic-sdlc.mjs approval requests --root <project> --story ST-001 --json
node bin/agentic-sdlc.mjs report query --root <project> --text "show all changes made by me" --json
node bin/agentic-sdlc.mjs report query --root <project> --query-json '<canonical-report-query-json>' --json
```

Activity reports reconstruct what happened from canonical trace files only. Business view focuses on decisions, validation, risk, handoffs, implementation, and release. Dev view includes evidence, branch/SHA, related IDs, and source lines. Agent-verbose view includes raw trace, git, and run metadata for audit.

Use `approval requests` before continuing when a baseline, capability profile, capability recommendation, output template, contract clarification, contract approval, or canonical output link needs human agreement. Proposal commands for those artifact types return an `assistant_message` and `approval_request` too; show those when available instead of saying only that artifacts were prepared. The command is intentionally user-facing and returns `assistant_message` plus `assistant_message_presentation`. Agents should translate and contextualize `assistant_message` in the active chat language when `translate_to_chat_language` is true. Present plain-language meaning first: baseline means trusted project context, capability profile means tools-and-permissions boundaries, capability recommendation means concrete tool choices, output template means assessment/output format, and contract means the work brief. Preserve IDs, paths, commands, status codes, and schema keys only as technical detail when needed. Present what must be reviewed, why it matters, what approval means, whether more information is needed, and what will happen next. Do not reduce approval to a bare question, a file link, or a list of artifact IDs; summarize relevant baseline report, capability records, template, contract, and source-list contents directly in chat. For output-template approvals, show the sections, template content when useful, delivery/presentation options, recommended delivery, and delivery question before asking. Approval scope is exact: a user response approves only the displayed request, not later artifacts. Then stop until the user approves, answers, or asks for changes.

Use `report query` for broader natural-language history questions. Codex or another LLM should normalize the user request into `schemas/report-query.schema.json`; the CLI then filters canonical KB records deterministically. Supported subjects are `activity`, `stories`, `story_steps`, `outputs`, `contracts`, `handoffs`, `work_items`, `approvals`, `tests`, and `all`.

Example normalized query for "all changes made by me":

```json
{
  "intent": "find_changes_by_actor",
  "confidence": 0.95,
  "subjects": ["activity", "stories", "outputs", "contracts", "approvals"],
  "filters": {
    "actor": ["<current-user-id-or-email>"]
  },
  "sort": "created_at_desc"
}
```

Example normalized query for "all changes made by Codex at my request":

```json
{
  "intent": "find_changes_requested_by_user",
  "confidence": 0.95,
  "subjects": ["activity"],
  "filters": {
    "executor": ["codex"],
    "requester": ["<current-user-id-or-email>"]
  },
  "sort": "created_at_desc"
}
```

Example normalized query for "all new functional stories from the last 10 days":

```json
{
  "intent": "find_new_functional_stories",
  "confidence": 0.95,
  "subjects": ["stories"],
  "time": {
    "since": "10d",
    "until": "now",
    "field": "created_at"
  },
  "filters": {
    "text": ["functional"]
  },
  "sort": "created_at_desc"
}
```
