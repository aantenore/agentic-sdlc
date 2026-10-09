# CLI Commands

Run commands with Node from the plugin root (`<plugin-root>`, two directories above `skills/agentic-sdlc/SKILL.md`):

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

After delivered work, record the new project state with `baseline refresh --from <approved-baseline-id>` from the base branch with its changes committed. The refresh is refused on a story branch that is not merged yet and over uncommitted changes inside the baseline scope; tell the user to switch to the base branch (`git switch main`), pull, and run it again. Use `--allow-non-base-branch` or `--allow-uncommitted-changes` only when the user explicitly confirms that this checkout is the project state to record. If a proposed refresh must not replace its predecessor (for example it was taken from a story branch), withdraw it after the user agrees instead of approving it:

```bash
node bin/agentic-sdlc.mjs baseline refresh withdraw \
  --root <project> \
  --id BASELINE-INITIAL-R2 \
  --reason "Recorded from an unmerged story branch" \
  --actor-type human \
  --approval-source explicit-user \
  --summary "Withdraw the refresh taken from the story branch"
```

The withdrawn record stays as history and its shared claim on the git remote is released, so the next refresh of the predecessor works on every computer. Add `--from <baseline-id>` when the proposed record is not on this computer.

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
When the local-release target root is inside the Git worktree, as in the
examples below, the requirement paths must also include its project-relative
path (`.local-release`) and `.gitignore`, and `.gitignore` should ignore it;
otherwise `gate check --strict --lifecycle-complete` fails on the released
files. A target root outside the worktree needs neither, but it is a write
outside the workspace and needs the user's explicit agreement.

`requirement create` is a compatibility alias for proposal creation, not direct approval. A material revision changes the requirement hash and invalidates downstream delivery profiles bound to the old revision. Legacy `requirement:v1` records remain readable with a conservative `supervised` ceiling.

## Select Autonomy For Every Delivery

Every pull request and every local release needs a new delivery profile ID and an explicit choice among `supervised`, `checkpointed`, and `bounded-autonomous`. Never reuse a profile or approval from another delivery. One profile binds exactly one story and that story's one approved contract. When several stories must ship together, first create an agreed aggregation story/contract; do not use the profile as an unrelated multi-story container. Decide this at breakdown time: when the user wants one pull request or one local release for several parts, propose one delivery story with tasks (`work item create --type task --story <story-id>`) rather than approving several stories that will never be delivered separately.

When a story's delivery ends `cancelled` or `rolled_back`, the same story may
continue with exactly one new delivery instead of a replacement story: create a
new contract ID with `--replace-story-contract --delivery-profile
<new-profile-id>`, approve it, propose and approve the new profile (a fresh
autonomy choice), release the story claim, run `task start` with the new
contract and profile, and claim the story again. The story keeps its workflow
run and completed phases; the new task-start receipt links the replaced one,
and the write-scope, secret-scan, and lifecycle checks stay anchored to the
first task start. A delivery that is still active, or that ended `released`,
`merged`, `merged_externally`, or `ready_for_review`, cannot be replaced; a further successor is
possible only after the new delivery itself ends `cancelled` or
`rolled_back`. Stories without a workflow binding follow the same rule.

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
  --code-review not-required \
  --code-review-actor-type human \
  --code-review-approval-source explicit-user \
  --code-review-summary "No, complete it automatically" \
  --merge manual \
  --merge-actor-type human \
  --merge-approval-source explicit-user \
  --merge-summary "I will merge it on GitHub myself" \
  --json
```

Every new pull-request proposal must carry the user's answer to "do you want a code review before this PR is merged?": `--code-review required|not-required`, with `--code-review-actor-type human`, `--code-review-approval-source explicit-user`, and `--code-review-summary` quoting the user's words; `--code-review-actor <person-id>` names the person (default `user`). An agent or system choice is refused, and so is `--code-review` on a local release. Ask the question at the same step as the autonomy choice, before `task start`, and never infer it from an earlier story (see the skill, Workflow step 13). The answer is stored in the approved, hash-bound profile as `pull_request_target.code_review` (`decision`, `source` `explicit-user` or `standing-approval`, `actor_id`, `user_words`, `standing_approval_id`, `decided_at`); editing it breaks the profile hash, and a delivery that carries it cannot be approved with `--approval-source automation`. A proposal under `--standing-approval` without `--code-review` takes the standing approval's answer instead. A profile created before this option has no `code_review` and follows `gate_policy.merge_requires_code_review` without blocking or asking. The requirement is checked only at `pull_request.merge`; see [Record A Code Review](#record-a-code-review) for what it needs and how to change it after approval.

The same proposal also records how merging works, as the user's own answer to "how should merging this PR work?": `--merge manual|after-confirmation|automatic`, with `--merge-actor-type human`, `--merge-approval-source explicit-user`, and `--merge-summary` quoting the user's words. `manual` means the plugin never merges: a person merges on GitHub, then acknowledges it with [`autonomy delivery reconcile`](#acknowledge-a-merge-made-outside-the-plugin). `after-confirmation` (the usual behavior) means the plugin merges after a `pull_request.merge` checkpoint the person confirms. `automatic` needs `--merge-allowed`: the plugin merges once every gate passes, without that checkpoint, and it is refused at level `supervised`. The answer is stored in the approved, hash-bound profile as `pull_request_target.merge_decision` (`mode`, `source`, `actor_id`, `user_words`, `decided_at`). Ask it at the same step as the other two questions, before `task start`, and never infer it.

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

Keep an in-repository destination ignored by Git (for example
`/.local-release/` in `.gitignore` or `.git/info/exclude`) or place it outside
the repository. The proposal reports in-repository destinations that Git can
see in `review.destinations_visible_to_git` and prints a warning. Their files
pass the strict write-scope check only after the delivery is released and only
while the destination matches the smoke-tested artifact manifest; extra,
missing, or modified files (including runtime data written after release) fail
the gate, and files the repository tracked there before the story started stay
subject to the requirement write paths.

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

Passing `build.local` completion records a content manifest (relative paths,
modes, sizes, and SHA-256 digests) of every approved write path, except a
write path that holds a declared data-migration file. From then on
`rollback.verify`, `data.migrate`, `data.rollback`, and `release.local` require
the destination to match that manifest. A write path may be deleted and
recreated as long as its content still matches; the target root must keep its
identity, and symlinked or relocated write paths are always refused.

To update an existing local release, follow backup -> install -> smoke ->
rollback inside the governed actions; never install files at release time:

1. Propose a new delivery profile whose write paths are the destination and a
   backup directory (for example `--write-path <root>/app --write-path
   <root>/backup`) and whose `--rollback` restores the destination from the
   backup.
2. After task start, request `build.local`. While that authorization is open,
   copy the current release into the backup path, then install the new build
   into the destination (replacing the directory is fine).
3. Complete `build.local` with immutable evidence; the CLI records the content
   manifest.
4. Rehearse the rollback without changing the destination (for example restore
   the backup into a scratch copy) and record `rollback.verify` with that
   evidence.
5. Authorize and complete `release.local`; the sandboxed smoke test runs
   against the exact recorded content.
6. If the smoke test fails, restore the backup as the rollback procedure says
   and close the delivery with `--terminal-status rolled_back`.

When the destination changed after `build.local` (a hotfix, a reinstall with
other files), the refusal names the changed write paths: request `build.local`
again, install the build, complete it, then repeat `rollback.verify` and
`release.local`.

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

`autonomy delivery explain` and `status` state, for a pull request, whether a code review is needed before merge and where that comes from: `project_policy` (the project requires one for every pull request), `delivery_profile` (the user chose it for this story), `standing_approval`, `change` (changed after approval), or `project_default` (a profile created before the choice existed). When a review is required they also show how many of the reviews recorded on this computer are valid for the current head ("N of M"). In JSON this is `code_review` in `explain` and `code_review_before_merge` in `status`, which lists every open pull-request delivery with its requirement.

Before approving, review the complete proposed JSON: requirement ceiling, selected level, target identity, allowed actions, write paths, automatic phases, checkpoints, exception triggers, merge/deploy exclusions, expiry, and the non-reuse boundary. A `--level` above the most restrictive requirement ceiling or the approved contract level is not refused: the profile keeps it as `requested_level` and stores `effective_level`, the choice capped by that ceiling and contract; the proposal `review` shows `effective_level` and `level_capped_by`, and the guidance says the choice was capped. Every enforcement point uses `effective_level`, never `requested_level`. An unknown `--level` is refused. In `audit_only`, a requested `bounded-autonomous` profile evaluates only as `checkpointed`, including for local releases. Effective `bounded-autonomous` requires an external host/CI to sign the exact profile-approval subject with Ed25519, `authority_policy.mode: host_verified`, the public key in `authority_policy.trusted_host_keys`, and `--host-receipt-file <path.json>` on `autonomy delivery approve`. The CLI verifies that receipt; it cannot self-issue trusted authority.

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

## Standing Approvals For Repeated Low-Risk Deliveries

A standing approval lets similar deliveries proceed without a confirmation for each one. It never exists without the user's explicit approval, covers only the `checkpointed` level, and never covers merge, production, deploy, data migrations, force-push, or deletions of tracked files outside its paths. Every bound is mandatory; the expiry is capped by `standing_approval_policy.max_validity_days`.

For `--destination pull_request`, `--repository <owner/repository>` is required and pushes are confined to head branches under `--head-branch-prefix` (default `standing/<id>/`). The base branch and shared, release, or production branches (`main`, `master`, `develop`, `release/*`, `prod*`, ...) are never covered. A work brief approved under a standing approval must be for a non-release phase, must not allow infrastructure tools (`kubectl`, `terraform`, cloud CLIs, ...), must name a delivery that is new or proposed under the same standing approval, and the briefs it approves never name more deliveries than `--max-deliveries`.

For `--destination pull_request`, `--code-review required|not-required` is also required: it records the user's answer to the code review question for every pull request the standing approval covers, and `autonomy standing explain` states it in plain language. A delivery proposed with `--standing-approval` and no `--code-review` takes that answer (stored with `source: standing-approval` and the standing approval id) and is not asked again. An explicit `--code-review` answer that differs from the bound is outside the standing approval: the delivery is not covered and goes through the normal question and approval. A standing approval proposed before this option has no bound, so each delivery under it needs the user's own answer. A standing approval never covers a merge, whatever it records here. Recording `--code-review not-required` is how a user states once that none of these stories need a review; it is bounded by the same deliveries, expiry, and revocation, and is never inferred from earlier answers.

`--budget-per-delivery`, `--budget-total`, and `--currency` set an optional cost budget, accepted only when a source that reports delivery cost is configured (the CodeBurn adapter with its `cost` mapping, or a trusted signed source whose metrics include `cost`); otherwise propose is refused and nothing is recorded. Amounts are exact decimals. A step is covered only when a verified meter reading of the delivery's cost is newer than its last recorded step, its meter started within 5 minutes of the delivery's approval and before the work, and its window reaches today (run `budget meter start --delivery <profile-id>` right after `autonomy delivery approve` and before `task start` and `budget meter record --delivery <profile-id>` before each step), the delivery's cost is within the per-delivery budget, and the cost of every delivery that used the standing approval is within the total; a hand-declared cost counts toward the amounts but never makes a delivery measured, and a total that includes a delivery without a fresh verified reading here (record a final one for a finished delivery) is not measurable; a delivery whose meter started late, or that ended before any meter started, keeps that total unmeasurable for good (continue with normal confirmations, or revoke and have the user approve a new standing approval). Otherwise the normal confirmation applies.

```bash
node bin/agentic-sdlc.mjs autonomy standing propose \
  --root <project> \
  --id SA-FLAGS \
  --recipe flag-cleanup \
  --description "Remove one retired feature flag and release it locally" \
  --requirement REQ-FLAGS \
  --write-path src/flags --write-path docs \
  --max-changed-files 10 --max-changed-lines 200 \
  --destination local_release \
  --max-deliveries 5 \
  --expires-at 2026-11-01T00:00:00Z

# A pull-request destination also records the user's code review answer.
node bin/agentic-sdlc.mjs autonomy standing propose \
  --root <project> \
  --id SA-DEPS \
  --recipe dependency-bump \
  --description "Bump patch versions of npm dependencies" \
  --requirement REQ-DEPS \
  --write-path package.json --write-path package-lock.json \
  --max-changed-files 2 --max-changed-lines 400 \
  --destination pull_request \
  --repository owner/repository \
  --code-review not-required \
  --max-deliveries 5 \
  --expires-at 2026-11-01T00:00:00Z

# Only after the user explicitly approves the displayed limits.
node bin/agentic-sdlc.mjs autonomy standing approve \
  --root <project> --id SA-FLAGS \
  --actor-type human --approval-source explicit-user \
  --summary "Approve up to 5 flag cleanups released locally until November"

# In a host_verified project: the same command plus the trusted host's receipt
# for this exact standing approval (never written or signed by the agent).
node bin/agentic-sdlc.mjs autonomy standing explain --root <project> --id SA-FLAGS --json   # host_receipt_request
node bin/agentic-sdlc.mjs autonomy standing approve \
  --root <project> --id SA-FLAGS \
  --actor-type human --approval-source explicit-user \
  --summary "Approve up to 5 flag cleanups released locally until November" \
  --host-receipt-file .sdlc/receipts/host/SA-FLAGS-approve.json

# A matching delivery: no approver options, no --confirm-action.
node bin/agentic-sdlc.mjs contract approve --root <project> --id CONTRACT-FLAG-12 --standing-approval SA-FLAGS
node bin/agentic-sdlc.mjs autonomy delivery propose --root <project> --id AUT-FLAG-12 ... --level checkpointed --standing-approval SA-FLAGS
node bin/agentic-sdlc.mjs autonomy delivery approve --root <project> --id AUT-FLAG-12 --standing-approval SA-FLAGS
node bin/agentic-sdlc.mjs autonomy delivery action --root <project> --id AUT-FLAG-12 --action build.local

node bin/agentic-sdlc.mjs autonomy standing status --root <project> --json
node bin/agentic-sdlc.mjs autonomy standing explain --root <project> --id SA-FLAGS
node bin/agentic-sdlc.mjs autonomy standing sync --root <project> --id SA-FLAGS
node bin/agentic-sdlc.mjs autonomy standing revoke \
  --root <project> --id SA-FLAGS \
  --reason "Flag cleanups need a review again" \
  --actor-type human --approval-source explicit-user --summary "Stop the standing approval"
```

A delivery proposed with `--standing-approval` turns every allowed delivery action into a confirmation point. Approving the delivery consumes one delivery slot atomically. At each action the CLI re-checks that the standing approval is approved, unexpired, unrevoked, bound to the same project, configuration, policy, and requirement hashes, and that the changes since task start stay inside its paths, file and line limits, and destination, and any cost budget as described above. When everything fits, the action receipt carries a derived approval with `approval_source: standing-approval` and the standing approval id, hash, and slot. Otherwise the command answers `checkpoint_required` with `standing_approval.reasons`, and the normal confirmation applies. A revocation or expiry also stops completing an action authorized under it; confirm the action directly and complete the new authorization with `--authorization-receipt`.

Used slots and revocations are shared through the git remote named by `standing_approval_policy.coordination.remote` (default `origin`) as refs under `refs/agentic-sdlc/standing/<id>/<hash>/`: a slot is claimed on the remote with a create-only push before it is recorded locally, and every covered step fetches those refs first. With `mode: auto` (default) sharing applies when the remote exists; `required` refuses without it; `local_only` never shares. An unreachable remote, a remote other than the one recorded at proposal (renamed, re-pointed, or a fork), a malformed shared record, a record that disappeared from or changed on the remote, a shared revocation, or all slots used elsewhere means the step is not covered and the normal confirmation applies. `autonomy standing approve` is refused inside an agent session (`CLAUDECODE`, `CODEX_THREAD_ID`, or `CODEX_AGENT_NAME` set); the user runs it in their own terminal. Records are pushed to the remote's fetch address, and revocations and used slots are also kept in `refs/agentic-sdlc-local/`, so cleaning or deleting record files never undoes them. `standing revoke` publishes the revocation and reports `shared_revocation.status` (`shared`, `local`, or `failed`); after `failed`, run `standing sync` once the remote is reachable. Never delete or rewrite these refs by hand.

Signed standing approvals: in `host_verified` authority mode, `autonomy standing approve` requires `--host-receipt-file` with a `host-approval-receipt:v2` signed by a key in `authority_policy.trusted_host_keys`, for action `autonomy.standing.approve` and the subject `{ kind: "standing_approval_decision", action, decision, standing_approval_id, standing_approval_hash, expires_at }` (printed as `host_receipt_request` by `propose --json` and `explain --json`), decided by a person or approved CI actor and valid when the approval is recorded. A `max_authorization_ttl_seconds` shorter than the time to expiry, or `no_external_access` on a pull-request destination, refuses it. A receipt for another record, another decision, or a different expiry, a tampered receipt, or an untrusted key is refused and nothing is approved. The verified receipt is embedded in `approval.json` (`assurance`, `host_receipt`) and verified again at every read as of its signed `decided_at`; the receipt's `expires_at` also ends coverage, and a record time before the receipt was decided, before the proposal, after the receipt expired, or in the future is invalid. Derived approvals carry `standing_approval_ref.host_receipt_ref`, which the strict gate checks, and a delivery approved under it records `authority_assurance` `host_verified` with `source: standing_approval_receipt`, which its later actions must match. A standing approval records the mode it was proposed under (`authority_mode`); proposed under `host_verified` without a valid receipt it is `invalid` and covers nothing. `autonomy standing revoke` verifies and records a receipt for `autonomy.standing.revoke` when one is given, and otherwise accepts the person's explicit revocation, because revoking only removes authority. In `audit_only` mode a receipt is optional; when given it is verified the same way and `status`, `explain`, and the Change Observatory show `assurance: host_verified`. Switching an existing project to `host_verified` makes earlier unsigned standing approvals `stale` (no new work) while their derived approvals stay valid history. Rotate keys by keeping the old entry with `retired: true` (optionally `not_after`): it keeps verifying receipts decided while it was valid, but it stops granting new authority at once (no new decision, no new work under a standing approval it signed, no task start or action under a delivery whose authority it signed, no completion of a pending authorization it signed); removing a key also invalidates the history it signed. A standing approval's receipt must be decided after its proposal.

Limits of the measurement: changes are compared as the net difference between the delivery's task-start base and the current working tree, plus untracked files; files Git ignores are not counted, so keep generated or ignored output inside the agreed paths. A work brief that requires a direct approval for a capability boundary always needs the person, and a `host_verified` project relies only on a standing approval signed by the trusted host. Approving a work brief under a standing approval consumes no delivery slot; only the delivery approval does, and only for a delivery proposed under that standing approval.

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

Local completion runs the approved smoke argv without a shell from the exact governed `--smoke-cwd`. Shells, indirect dispatchers, inline interpreter code, and ambiguous loaders are rejected. Explicit interpreted entrypoints must resolve inside an allowed artifact path; package managers may only use `test` or one reviewed `run <script>` from the real package in that directory. Before spawning, a durable write-ahead attempt consumes the v3 authorization and binds the plugin build, sandbox, resolved launcher/runtime, explicit payload paths and pre-smoke artifact manifest. The supported read-only sandbox denies external network; macOS denies loopback and Linux `bwrap` exposes namespace-local loopback only. Portable smoke must not use listeners or connections; API artifacts should expose a handler that the smoke script invokes in-process. The runner can read host-account files and provides neither confidentiality nor transitive-code attestation, so reviewed artifact code must not load ungoverned host paths. Completion records ordered output hashes and an unchanged post-smoke manifest; failed or interrupted attempts require fresh authorization, current v3 receipts cannot downgrade to legacy, and later gates reject artifact drift. The directory must be equal to or inside one allowed write path; it defaults to the only write path and is required when several are allowed. Historical profiles without the field derive it only from one unambiguous write path and otherwise fail closed. Successful completion currently requires `/usr/bin/sandbox-exec` on macOS or `/usr/bin/bwrap` on Linux; unsupported hosts and Linux without `bwrap` fail closed before a `released` receipt is written. Passing `release.local` and `pull_request.merge` completions automatically close the lifecycle as `released` or `merged`; do not also call manual close for those statuses. A merge a person made on GitHub is closed as `merged_externally` only by `autonomy delivery reconcile`, never by manual close. A pull request whose profile excludes merge closes with `autonomy delivery close --terminal-status ready_for_review`, which binds its latest passing `pull_request.create` or `pull_request.update` completion, is refused after any later commit, push, or PR action, and needs no new approval. Use `autonomy delivery close` for formally approved `closed`, `cancelled`, `rolled_back`, `superseded`, or other allowed non-success terminal outcomes.

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

`<host-agent>` is the agent running the plugin (`codex` or `claude-code`).
Without `--actor` or `--agent`, the CLI detects the host from its environment;
set `AGENTIC_SDLC_AGENT_HOST` to choose one explicitly.

```bash
node bin/agentic-sdlc.mjs story create --root <project> --id ST-001 --title "Implement a business workflow" --requirement REQ-001 --acceptance "<observable story-level success criterion>"
node bin/agentic-sdlc.mjs task start --root <project> --story ST-001 --intent-json '<normalized implement_story intent>' --confirm-start --actor-type human
node bin/agentic-sdlc.mjs story claim --root <project> --id ST-001 --agent <host-agent> --branch feature/ST-001 --thread-id <host-thread-id>
node bin/agentic-sdlc.mjs story complete-step --root <project> --id ST-001 --step functional-analysis --type functional-analysis --summary "Functional review complete"
node bin/agentic-sdlc.mjs story prepare-handoff --root <project> --id ST-001 --to-agent implementation-agent --release-claim --summary "Ready for implementation"
node bin/agentic-sdlc.mjs story release --root <project> --id ST-001 --agent <host-agent> --reason "Work handed off"
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
  --agent <host-agent> \
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

### Claims shared across computers

When the project has the git remote named by
`orchestration_policy.coordination.remote` (default `origin`), `story claim`
first creates `refs/agentic-sdlc/claims/<story>/<epoch>/claim` on that remote
with a create-only push, and writes `claim.json` (with `shared_claim`) only
after the remote accepted it. Of two computers claiming the same story at once,
exactly one wins; the other gets `STORY_CLAIM_HELD_ELSEWHERE` with the holder,
branch, and time, and writes nothing. Releases (`story release`,
`--release-claim`, closing a started story) are written locally first and then
published as `.../<epoch>/release`; output reports `shared_release.status`
(`shared`, `already_shared`, `taken_over`, or `not_shared` with the reason).
After `not_shared`, run `story release --id <story>` again when the remote is
reachable: it shares the release without rewriting the claim.
A plain release made once the story's delivery is finished (terminal delivery,
passing release trace, completed release step) is published as `completed`,
with the delivery id, kind, terminal status, close time, merge commit, and close
receipt hash under `completion`; a story closed by `story supersede` or
`story cancel` is published as `closed`. Every other computer then treats the
story as finished, before its closing records reach its checkout:
`orchestrate status` and `status` list it as `closed` (`finished_elsewhere`),
`story availability` answers `finished`, and `story claim` and `story reserve`
are refused with `STORY_COMPLETED_ON_REMOTE`. Working on it again is a
person's decision: `story claim --force --reason <why> --actor-type human`.
Versions before 0.32.0 do not know `completed`: they report the story's shared
records as untrustworthy and refuse to claim it, never as free.
`gate check --lifecycle-complete` reports `closing_records` and warns while the
story's final receipt is not on the remote base branch yet (read from the last
fetch).

```bash
node bin/agentic-sdlc.mjs story claim --root <project> --id ST-001 --agent <host-agent> --branch feature/ST-001
node bin/agentic-sdlc.mjs story release --root <project> --id ST-001 --reason "Design finished"
# A person, in their own terminal, after deciding the holder cannot continue:
node bin/agentic-sdlc.mjs story claim --root <project> --id ST-001 --agent <name> --branch feature/ST-001 --force --reason "<why>" --actor-type human
```

When another story in progress has a write scope that shares files with the
claimed story, `story claim` lists it under `overlapping_stories`. Before
`pull_request.merge`, changes other stories merged after this story started
inside its write scope must be reviewed:

```bash
node bin/agentic-sdlc.mjs story overlap --root <project> --id ST-002 --json
node bin/agentic-sdlc.mjs story overlap confirm --root <project> --id ST-002 --summary "Rebased on ST-001 and re-ran the tests"
```

A commit that reached the base branch outside any delivery (pushed straight
to main) makes `git.commit` and `git.push` refuse the story branches that
picked it up. Commits that only touch `.sdlc/` records, and a commit followed
by its exact revert, never count. A person (human or CI actor, refused inside
an agent session) can accept one such commit for one story; its files then
stay out of the story's perimeter, and those inside its write scope or
context go through `story overlap confirm` before the merge:

```bash
# A person, in their own terminal:
node bin/agentic-sdlc.mjs story base acknowledge --root <project> --id ST-002 --commit <sha> --reason "<why it belongs on main>" --actor-type human
```

Taking over a story held on another computer needs `--force`, `--reason`, and a
human or CI actor, and is refused inside an agent session
(`STORY_CLAIM_TAKEOVER_NEEDS_PERSON`). The release record names who took over
and why; the previous holder's `orchestrate status` and `status` show it.

`orchestration_policy.coordination.mode` is `auto` (default: share when the
remote exists, otherwise keep claims on this computer), `required` (refuse to
claim without the remote), or `local_only` (never share, for one computer
only); `timeout_seconds` bounds each remote call. With sharing in effect, an
unreachable remote refuses the claim (`STORY_CLAIM_REMOTE_UNAVAILABLE`):
claiming is the start of work. A project without git keeps claims local. A
shared record that is unreadable, or that disappeared from or changed on the
remote after this computer saw it, refuses claims of that story
(`STORY_CLAIM_SHARED_RECORDS_INVALID`). Never push, delete, or rewrite these
refs by hand.

Ownership is decided by `refs/worktree/agentic-sdlc/claims/<remote>/...`, a
per-worktree record holding a secret whose hash is the claim's `owner_proof`;
`claim.json` is committed evidence, not proof. A pending record (push made, file
not yet written) is cleaned up on retry; a confirmed claim whose file is missing
in this worktree is treated as held. The plugin's hooks refuse fetching into,
or batch-writing (`update-ref --stdin` from a pipe or file), the refs the CLI
keeps for itself. Releasing a claim made on another computer (for example after checking
out its branch) needs `--reason` and a human or CI actor, outside any agent
session, and the release records who released it. Seen records are tracked
per remote under `refs/agentic-sdlc-shared/claims/<remote>/`. A claim push
whose answer is lost is re-checked on the remote; if the remote cannot be read,
the refusal says the claim may have landed and the next `story claim` from the
same computer releases it as `cancelled` first.

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

A dependency edge is `from:to:type:blocks:required_state`. The required state `merged` (for example `ST-002:ST-001:blocks:implementation:merged`) is satisfied only when the upstream story's pull request is merged, by the plugin or by an acknowledged external merge; a delivery that is only `ready_for_review` does not satisfy it. A verified merge stays satisfied even when the upstream story's final certification later reads as stale, for example because the dependent story edits files the upstream story certified.

Breakdowns and dependencies are proposed first, then approved by a human/CI actor or by delegated automation when the user explicitly gave a matching approval level. Hard dependency scopes block orchestration and strict gates; soft dependencies remain visible as warnings. When upstream artifacts change, record a `dependency.revalidate` trace on downstream stories after review.

When planned stories are abandoned before any work starts, close them instead
of leaving them as blocked work. `story supersede` names the story that now
delivers the work; `story cancel` records that the work will not be delivered.
Both take one `--id` or every story of an approved breakdown with
`--from-breakdown`, and both need a formal approval:

```bash
node bin/agentic-sdlc.mjs story supersede --root <project> --from-breakdown BD-REQ-001 --by ST-MVP \
  --reason "One delivery story replaced the planned split" \
  --actor-type human --approval-source explicit-user --summary "Replace the planned stories with ST-MVP"
node bin/agentic-sdlc.mjs story cancel --root <project> --id ST-004 \
  --reason "Out of scope for this release" \
  --actor-type human --approval-source explicit-user --summary "Drop ST-004"
```

Each closed story gets an immutable `.sdlc/stories/<story-id>/closure.json`
bound to the approved subject (story contents, replacement, breakdown, reason)
and a `story.supersede` or `story.cancel` project trace; `story.json` is never
rewritten. A story that already started (claim, task start, completed step,
workflow run, delivery profile, linked output, or work trace) can be closed
only on its own with `--id`, and only when every delivery bound to it is
terminal as `cancelled`, `rolled_back`, `closed`, `revoked`, or `superseded`;
an active or still-available delivery, a released, merged, or
ready-for-review delivery, or a lifecycle-certified story is refused. Its
closure also binds the task start, every terminal close receipt, and the
work assignment, which the closure releases, and it is traced on the story
itself. Reopening any of them later reports the story as blocked.
After closure, contract creation, workflow start, task start, delivery
proposals, output links, claims, and story traces for that story are refused.
Closed stories are reported as `closed` by orchestration and as `closed_work`
by `status`; dependency edges from them stop applying, and a dependency on a
superseded story is evaluated against its replacement. Cancelling a story that
active stories still depend on is refused: close the dependents first or
supersede it instead. A tampered closure, or a story edited after closure,
blocks that story until it is repaired.

### Split a story into several stories

Repeat `--by` when one story is split into several stories. The closure is then
written as `story-closure:v2`, with every replacement in `replacement_ids` and
`replacement_id: null`; a single `--by` still writes the unchanged
`story-closure:v1` record, and existing v1 records stay valid as they are.
Writing a v2 closure records that the project needs plugin 0.49.0 or later.

```bash
node bin/agentic-sdlc.mjs story supersede --root <project> --id ST-ORCH-001   --by ST-ORCH-001A --by ST-ORCH-001B --by ST-ORCH-001C   --reason "Split into client, tools, and agents with the orchestrator"   --actor-type human --approval-source explicit-user --summary "Split the orchestration story in three"
```

A dependency on a split story is never moved onto one of its parts
automatically. It stays unsatisfied (blocking when it is a hard dependency)
and `status`, `story deps`, and the gates report it as needing review:
`ST-CHAT-001A depends on ST-ORCH-001, which was split into ST-ORCH-001A,
ST-ORCH-001B, ST-ORCH-001C: a person must decide which of them ST-CHAT-001A
depends on ...`, with the `dependency revise` command that records the choice.
With a single replacement the dependency follows it as before.

The output of `story supersede` (JSON `dependents` and `dependency_review`)
lists every open story whose approved dependencies point at the closed story.
For a split it proposes the revision and approval commands, with a
`<A|B|C>` placeholder for each choice.

### Revise approved dependencies

`dependency revise` proposes a change to the approved graph: `--retire
from:to[:type:blocks]` stops evaluating approved edges, `--redirect
from:old-to:new-to` retires them and adds the same edge (type, scope, required
state, requirements) towards another story (repeat it to point one dependency
at several stories), and `--edge` adds a new edge. `--rationale` is required.
The revision is a proposal: nothing changes until a person approves it with
`dependency approve`, which an agent cannot do.

```bash
node bin/agentic-sdlc.mjs dependency revise --root <project> --id DEP-REV-ST-ORCH-001   --redirect ST-CHAT-001A:ST-ORCH-001:ST-ORCH-001A   --redirect ST-CHAT-001A:ST-ORCH-001:ST-ORCH-001C   --retire ST-IMPR-001:ST-ORCH-001   --rationale "ST-ORCH-001 was split; each dependent names the part it needs"
node bin/agentic-sdlc.mjs dependency approve --root <project> --id DEP-REV-ST-ORCH-001   --actor-type human --approval-source explicit-user --summary "Point each dependent at the part it needs"
```

Approved dependency records are never rewritten. On approval, each retired
edge stays in `.sdlc/dependencies/graph.json` with `status: "retired"`,
`retired_by_revision`, `retired_at`, and `retired_by`; redirected edges carry
`revises` with the edge they replace, and a `dependency.revise` project trace
records the decision. Retired edges are no longer evaluated by `status`,
`orchestrate`, `story deps`, `dependency status`, gates, or `task start`, and
approving an earlier proposal again does not bring them back. A revision is
refused when an edge it retires is no longer active (for example another
revision retired it first); propose it again from the current graph.
Approving a revision records that the project needs plugin 0.49.0 or later.

### Reading a dependency message

Every dependency message names the story it effectively waits on and where
that story stands, then the edge terms:

```text
ST-CHAT-001A depends on ST-ORCH-001 → superseded by ST-ORCH-001A [in progress (implementation), claimed by agente-orch-001a on another computer] (blocks, analysis, requires merged)
ST-IMPR-001 depends on ST-ORCH-001C [draft (design), not claimed] (blocks, analysis, requires merged)
```

The state is `merged`, `done`, `blocked`, `in progress (<phase>), claimed by
<agent>` (with `on another computer` when `status` read the shared claims on
the remote), or `<status> (<phase>), not claimed`. A superseded story is not a
permanent blocker: the dependency waits on its replacement.

## Capability Discovery

```bash
node bin/agentic-sdlc.mjs capability profile propose \
  --root <project> \
  --id CAP-PROFILE-ST-001 \
  --story ST-001 \
  --phase analysis \
  --context-file .sdlc/requirements/REQ-001.json
node bin/agentic-sdlc.mjs capability profile approve --root <project> --id CAP-PROFILE-ST-001 --actor-type human --approval-source explicit-user --summary "Approved capability profile"
node bin/agentic-sdlc.mjs capability inventory --root <project> --json
node bin/agentic-sdlc.mjs capability recommend \
  --root <project> \
  --id CAP-REC-ST-001 \
  --profile CAP-PROFILE-ST-001 \
  --from-inventory
node bin/agentic-sdlc.mjs capability approve --root <project> --id CAP-REC-ST-001 --actor-type human --approval-source explicit-user --summary "Approved capability recommendation"
node bin/agentic-sdlc.mjs capability status --root <project> --story ST-001 --json
```

Use profile records to capture project/story context, detected stack, constraints, integrations, evidence, source paths, and source hashes. Use recommendation records to capture skills, MCPs, tools, connectors, plugins, models, concrete bindings, decision matrices, open questions, and execution-policy suggestions.

`capability inventory [--json] [--full]` is read-only. It lists the skills,
commands, plugins, and MCP servers already installed for the user and the
project: skill and command directories and the plugin caches of both supported
agent hosts, MCP servers from `.mcp.json`, host settings, and the TOML host
configuration, and any other location named by
`capability_discovery_policy.inventory`. It keeps only names, one-line
descriptions, plugin versions, and a server's transport type; server
arguments, environment, headers, and URLs are never read into the output.
Paths are project-relative or `~`-relative, and there is no network access.
It works before `init` and changes nothing.

`capability recommend --from-inventory` uses that inventory as the available
capabilities, so the list is never built by hand. Only installed skills,
plugins, and servers whose name or description names a technology declared by
the approved profile (detected stack and integrations) are proposed, at most
`matching.max_suggestions`; the wording of a request is never matched, and the
other project-level entries are recorded by name as not recommended, and user-level ones are only counted (the record is committed with the project). The
output reports what was examined (`inventory_match`). The recommendation is
still `proposed` and needs approval. `--from-inventory` cannot be combined with
`--available-capabilities-json` or `--available-capabilities-file`, which stay
available for tools the inventory cannot see.

Without any inventory, the default recommendation may use only capabilities
proven by the running plugin or detected local project surface: the Agentic
SDLC governance capability itself and, for a detected Node.js project, the
local test runner. A default recommendation must not mark the running plugin
itself as unknown and then fail only after delivery approval.

When a story has no capability recommendation and installed capabilities match
its declared technology, `task start` and `status` also return a
`capability_suggestion` (`capability-suggestion:v1`: `story_id`, `phase`,
`basis`, `tags`, `matches`, `message`, `commands`) and a short plain-language
sentence. It is silent when a recommendation or profile is already approved or
pending, when nothing matches, or when `capability_discovery_policy.inventory`
sets `suggest` or `enabled` to `false`. It never changes the decision and never
approves, binds, or installs anything; running the listed `commands` only
records a proposal.

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

When claims are shared through the git remote, both commands (and the project
`status`) read every computer's claims with one `ls-remote` while some story
is still open. A story held elsewhere is `claimed` (or `stale` once it expires
or is older than `orchestration_policy.stale_claim_after_seconds`) with
`shared_claim.holder` (agent, branch, claimed and expiry time) and
`shared_claim.here: false`; it is never offered as an available lane.
`shared_claim.ended_here` tells the previous holder that its claim was released
or taken over, by whom, and why. `shared_claims.checked: false` means the
remote could not be read; other computers' claims are then not shown.

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

The included v3 definition requires the exact stock seven-phase `phase_order`.
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

`--base` defaults to the commit the story's task start recorded and `--head` to the current `HEAD`. A story whose task start recorded the empty tree (a repository that had no commit yet) compares from that tree once `HEAD` exists, so the whole first commit is covered. The gate accepts only a scan whose base is that task-start commit or an ancestor of it; a narrower range is stored but reported as not covering the delivery. Uncommitted and untracked files are scanned with the default range, and the record binds that working-tree state, so the gate accepts it only until the working tree changes; a range named with `--base` or `--head` skips the working tree and counts only while it is clean. A committed range file the working tree has changed is also read as the head holds it, so an uncommitted edit cannot hide a committed credential. A story with no base, including one in a repository without its first commit, is scanned from the uncommitted workspace, and a local release with neither falls back to the story's approved write paths.

Findings are reported as the rule, the file, the line, and at most four leading characters of the match; the matched value is never printed or stored. A clean scan exits `0` and a scan with findings exits `1`. When `gate_policy.secret_scan.enabled` is `true`, a story in validation (the bound workflow instance's current phase, or `story.json` for a story without one) needs a record whose outcome is `clean` for the current head, and `gate check --strict --lifecycle-complete` requires the same for the head it certifies. Rules come from `gate_policy.secret_scan.rules` merged over the shipped defaults by `id`, and `gate_policy.secret_scan.exclude_paths` lists path globs to leave out.

## Record Incidents And Feedback

Use `incident record` and `feedback record` for a story in the `operations` phase, once a change is released. Both bind the story to a `--release-manifest` and refuse an ID or path that does not resolve to an existing manifest under `.sdlc/releases/manifests/`; neither is a blocking gate.

```bash
node bin/agentic-sdlc.mjs incident record \
  --root <project> \
  --story ST-001 \
  --release-manifest RELEASE-ST-001 \
  --severity sev2 \
  --summary "Checkout latency spike" \
  --impact "5% of checkouts timed out for 20 minutes" \
  --incident-action "Rolled back the checkout service" \
  --detected-at 2026-09-16T10:00:00Z \
  --resolved-at 2026-09-16T10:20:00Z

node bin/agentic-sdlc.mjs feedback record \
  --root <project> \
  --story ST-001 \
  --release-manifest RELEASE-ST-001 \
  --feedback-source monitoring \
  --sentiment negative \
  --summary "Error rate rose after release" \
  --evidence .sdlc/operations/dashboard-snapshot.png
```

`--severity` is one of `sev1`..`sev4`; `--feedback-source` is one of `user`, `monitoring`, `review`, `other`; `--sentiment` is `positive`, `neutral`, or `negative`. `gate check` for a story in `operations` adds checked lines with the incident and feedback counts, and warns — never fails — when it has neither yet.

## Record A Code Review

Use `review record` to record a review of one pull-request delivery's diff as a `code-review:v1` record under `.sdlc/reviews/`:

```bash
node bin/agentic-sdlc.mjs review record --root <project> --delivery AUT-PR-001 --verdict approved --actor <reviewer-id> --actor-type human
node bin/agentic-sdlc.mjs review record --root <project> --delivery AUT-PR-001 --verdict changes_requested --finding '{"severity":"blocking","summary":"Refund path skips the audit trace","path":"src/refund.js","line":42}' --json
```

The reviewed head commit and the base commit are read from the repository (the delivery's head branch must be checked out), and the reviewer's Git name and email from the local Git configuration; there is no option to name a commit. An approval cannot carry a `blocking` finding.

### When a review is required

A review is required for a pull-request delivery when the user chose it for that story (the answer given to `autonomy delivery propose --code-review`), or when the project policy requires it for every pull request. The template sets `gate_policy.merge_requires_code_review` to `false`. An existing project that explicitly has `true` keeps it: it requires a review for every pull request and no story answer lowers it. To change the policy, edit `.sdlc/config.json`, preview with `config migrate`, then apply with `config migrate --apply --plan-hash <hash>`. A profile created before the per-story answer existed has none and follows the project default. `autonomy delivery explain` and `status` show which source applies (`project_policy`, `delivery_profile`, `standing_approval`, `change`, `project_default`).

The requirement is checked only at `pull_request.merge`, never at `git.commit`, `git.push`, `pull_request.create`, `pull_request.update`, closing as `ready_for_review`, or any gate, including `gate check --strict --lifecycle-complete`. When it applies, `autonomy delivery action --action pull_request.merge` exits `1` unless an approved `code-review:v1` record exists for the exact head being merged, with a valid schema and `record_hash`, by a reviewer whose actor and Git email differ from every commit author in `base..head`. A later `changes_requested` from an independent reviewer blocks the merge, and a new commit on the head branch requires a new review.

### Change the requirement after approval

```bash
node bin/agentic-sdlc.mjs review require --root <project> --delivery AUT-PR-001 --summary "The user asked for a review before merge"
node bin/agentic-sdlc.mjs review waive --root <project> --delivery AUT-PR-001 --actor-type human --approval-source explicit-user --summary "<the user's words>"
```

Before the task starts, re-propose the delivery with the new answer instead. After approval:

- `review require` adds the requirement. Anyone may run it. It applies at once, also to a delivery in progress, and only at merge.
- `review waive` drops it. Only the user can decide that: it needs `--actor-type human --approval-source explicit-user` and the user's words in `--summary`, it is refused inside an agent session (the user runs it in their own terminal), and it is refused when the project policy requires reviews for every pull request.

Each writes a hash-bound record, `code-review-requirement-change:v1`, under `.sdlc/reviews/requirement-changes/`, bound to the profile id and hash, and appends a `review.require` or `review.waive` trace event. A record whose hash no longer matches, or a waiver not made by a person, is ignored.

### Reviews from another computer

A review recorded on another computer counts at merge only after it is shared. Sharing is an explicit, user-initiated step; nothing is published automatically:

```bash
node bin/agentic-sdlc.mjs review publish --root <project> --delivery AUT-PR-001 [--review <review-id>]
node bin/agentic-sdlc.mjs review fetch --root <project> --delivery AUT-PR-001
```

`review publish` pushes each valid review of the delivery recorded here (or only `--review`) to the coordination remote as a create-only ref, `refs/agentic-sdlc/reviews/<profile-id>/<profile-hash16>/<review-id>`. It never pushes or changes the pull-request branch or any other branch. `review fetch` reads those refs into `refs/agentic-sdlc-shared/reviews/...` and reports which are valid for the current head and why the others are ignored. At merge the plugin does a read-only fetch of the same refs. A received review counts only when its schema and `record_hash` are valid, it is for the same delivery profile (id and hash) and the same repository, its `reviewed_head_sha` equals the head being merged, and its reviewer is independent of the `base..head` authors, recomputed locally; otherwise it is ignored with a reason. An unreachable remote leaves only the reviews recorded on this computer. The remote and timeout come from `orchestration_policy.coordination`. The refs are create-only, like those used for standing approvals and story claims, so two computers never conflict on one mutable ref.

### Independent review on the same computer

`review record` uses the Git configuration identity as the reviewer, so the person guiding the agent can record an independent review on the same computer only if the agent's commits carry another identity. Recommend that the agent commit with a dedicated identity through environment variables, for its own commits only:

```bash
GIT_AUTHOR_NAME=agent-dev-1 GIT_AUTHOR_EMAIL=agent-dev-1@users.noreply.invalid \
GIT_COMMITTER_NAME=agent-dev-1 GIT_COMMITTER_EMAIL=agent-dev-1@users.noreply.invalid \
git commit ...
```

Leave the repository's `user.name` and `user.email` as the person's identity. Do not set the agent identity in the repository Git configuration: the person's review would carry it and would not be independent.

## Archive And Restart A Never-Published Project

`.sdlc` holds permanent approvals and consumption records, so the host hooks forbid every deletion inside it. When a project that was never published must start over, `project archive` moves `.sdlc` aside instead. It never deletes or copies-then-deletes.

```bash
node bin/agentic-sdlc.mjs project archive --root <project>
```

The plan changes nothing. It reports whether anything shows the project was published or shared, how many files would move, the hash of the tree, and the plan hash. It refuses, and lists why, when any of these exist:

- a ref under `refs/agentic-sdlc/`, `refs/agentic-sdlc-shared/`, `refs/agentic-sdlc-local/`, or `refs/worktree/agentic-sdlc`;
- shared project state on any configured git remote, or a remote that cannot be reached to confirm there is none;
- `.sdlc` committed in history that a remote-tracking branch already contains;
- delivery execution records, or delivery usage and standing-approval consumption records;
- trace events recording a push, pull request, or merge.

The person applies the plan from their own terminal. An agent session is refused, and the host hook asks the agent to hand over the exact command:

```bash
node bin/agentic-sdlc.mjs project archive --root <project> --apply --plan-hash <sha256> \
  --reason "Restart before first publication" \
  --actor-type human --approval-source explicit-user --summary "<the person's words>" \
  [--reinit [--project-name "<name>"] [--project-id <id>]]
```

The tree moves to `.sdlc-archive/ARCHIVE-<timestamp>-<hash8>/sdlc/` with `archive-manifest.json` beside it (who, when, why, the approval, and the hash of the archived tree, re-checked after the move). `.sdlc-archive/` ignores itself in git and is protected by the host hook from shell deletion and edits. A stale plan hash, a missing reason, or a non-human approval stops the command before anything moves. Without `--reinit`, run `init` afterwards; with it, the fresh `.sdlc` keeps the manifest at `.sdlc/decisions/project-archive-<id>.json` and a `project.archive` decision in `traces/project.jsonl`.

## Acknowledge A Merge Made Outside The Plugin

When a person merges a plugin-managed pull request directly on GitHub, the plugin does not see it. `status` detects the clear cases without writing anything: a head covered by the delivery's receipts is already on the remote base branch (payload key `merged_outside_plugin`), and `status` prints the command below. A squash or rebase merge leaves no trace in git, so `status` cannot detect it, but `reconcile` still works.

```bash
node bin/agentic-sdlc.mjs autonomy delivery reconcile --root <project> --id AUT-PR-184 \
  --pr-url https://github.com/owner/repository/pull/184 \
  --actor-type human --approval-source explicit-user \
  --summary "I merged PR 184 on GitHub myself"
```

Only a person or CI runs it. It is refused inside an agent session, the hooks deny it to agents, and they protect `.sdlc/autonomy/executions/<id>/external-merge.json`. It asks GitHub with `gh pr view` and requires all of this, otherwise it refuses with the reason and records nothing:

- the state is `MERGED`, with a merge commit and `mergedAt`;
- `mergedAt` is not earlier than the plugin's last recorded action for the delivery;
- the merged head equals the head the plugin's receipts cover: the latest passing `git.push` or `pull_request.create`/`pull_request.update`, or the pinned reviewed head of an existing pull request. Any commit the receipts do not cover is refused;
- the PR URL, head branch, and base branch are the approved ones.

The same code review rule as a governed merge applies to the merged head. On success the command writes the receipt `.sdlc/autonomy/executions/<id>/external-merge.json` (merge commit, `mergedBy`, `mergedAt`, verified head, the person's approval). A started delivery is closed with the terminal status `merged_externally`; a delivery already closed as `ready_for_review` keeps that close untouched and gains the receipt beside it. No existing record is rewritten, and running the command again changes nothing.

A story's final certification survives the reconcile: its trace may gain only the reconcile event and its delivery execution records only the new files. After the merge, `gate check --strict --story <id> --lifecycle-complete` certifies the story on the merge commit (`git_scope.anchor`), so work merged later on the base branch is never charged to it; the merge commit must be in the clone and an ancestor of HEAD, otherwise the gate asks to fetch the base branch. `secret scan --story <id>` on a merged story scans the files changed between the task-start base and the merge commit as that commit holds them.

After sealing, a final certification follows four rules. Records are
never rewritten; the rules only decide how a receipt is read.

1. **A story's own records never change.** Its contract, requirements,
   requirement and delivery profiles, workflow instance, events, checkpoint
   and definition, test records, story records and output registry entry must
   stay exactly as certified. Delivery execution records and related
   governance records may only gain files, and the story records only gain
   files under `base-acknowledgements/`. The story trace may only gain
   `autonomy delivery reconcile` events after its certified content, with its
   hash chain and checkpoint still verifying as `trace verify` checks them.
   Anything else voids the receipt (`final_receipt_check:story_record_changed`)
   and names the changed record.
2. **Shared files make it stale only once the delivery finished.** Changes to
   the project record, the configuration and its lock, referenced governance
   records, the files in the story's write paths, and local release targets
   make the certification stale. A stale story stays completed only with
   `certification_drift.mode: stale` and a finished delivery: a pull request
   merged by the plugin or acknowledged with `autonomy delivery reconcile`, or
   a local release closed as `released`. Before that the story is blocked
   (`final_receipt_check:workflowFinalFreshnessProofMatches`).
3. **A merged story is certified on its merge commit.** When
   `--lifecycle-complete` runs for a story whose pull request is merged, the
   merge commit must be in the clone and an ancestor of HEAD. The changed-path
   perimeter, the baseline coverage and the secret scan use the story's own
   commits up to that merge commit, not the working tree or later work on the
   base branch, and the receipt records
   `git_scope.anchor: { kind: "merge_commit", sha }`. Such a receipt is later
   checked against the merge commit only.
4. **Missing or rewritten history is named.** A certified commit absent from
   the clone gives `final_receipt_check:certified_commit_missing`; one that is
   no longer an ancestor of HEAD gives
   `final_receipt_check:certified_history_rewritten`. Neither is ever stale.

The story then counts as delivered. `gate check --strict --lifecycle-complete` may pass, but its final certification check carries the reduced label `certification: "externally_reconciled"`, because the plugin did not perform the merge. `autonomy delivery checks` shows an "external merge" row, and the Change Observatory labels it "Merged outside the plugin" ("Unita fuori dal plugin").

## Bring The Clone Up To Date Before Status

`status` first brings the clone up to date, as `orchestration_policy.status_sync.mode` says (default `fetch`):

- `off` reads the clone as it is.
- `fetch` updates only the remote-tracking branches; no file on disk changes.
- `pull` also fast-forwards the current branch, and only when it has no local commits ahead of its upstream. It never merges, rebases, or forces.

`status --sync off|fetch|pull` overrides the setting for one run; the `AGENTIC_SDLC_STATUS_SYNC` environment variable overrides it for one environment, such as a CI job. When the remote cannot be reached, `status` only warns and reports the clone as it is.

When the current branch is behind its upstream after the fetch, or the remote cannot be reached, the first line under the outcome says so ("Attention: this copy is N commit(s) behind origin/main (M project record(s) changed there); the counts below may be out of date"), because every count is read from this copy. `workspace_sync.records_behind` counts the `.sdlc` files the upstream changed.

## What Status Names

Besides the counts, `status` names the work, each list bounded by `orchestration_policy.status_list_limit` (default 5):

- `Ready to start`: stories nobody holds and nothing blocks (`work.ready_story_ids`).
- `Blocked`: each blocked story with its first blocker (`work.blocked`); `orchestrate status` prints every blocker under each blocked story.
- `To refresh`: records the agent rebuilds itself, with the command that does it (`work.refresh`). No approval is needed; they are refreshed when the agent runs that command, not by themselves.

`status --full --json` adds every pending decision, refresh item, and the whole orchestration snapshot.

## Follow A Dependency Chain

`story deps --id ST-001` lists the direct dependencies; each message names the story it effectively waits on and its state (see "Reading a dependency message"). `story deps --id ST-001 --transitive` follows every unsatisfied dependency upstream and ends with the root causes: unsatisfied upstream stories that wait on nothing themselves. Each story is expanded once, and a cycle is printed as `CYCLE A -> B -> A` instead of looping. JSON: `chain` (from, to, depth, satisfied, message), `root_causes`, `cycles`.

## Work Merged But Still Open

Story records move only through recorded lifecycle steps. A pull request merged by hand, or by an agent that stopped before recording completion, leaves the story open on every computer. `status` reports such stories (`merged_but_open`), read-only and from git alone, after its fetch:

- the remote base branch is `orchestration_policy.merge_drift.base_branch`, or the remote's default branch (`refs/remotes/<remote>/HEAD`; `git remote set-head <remote> --auto` sets it);
- a first-parent commit of it merges one of the story's branches (`parallel_work.branch_patterns`, or the claim's branch), or, with `match_commit_subject` (default true), its subject names the story id as a whole word;
- commits that change only `.sdlc` records and reverts never count; `max_commits_scanned` (default 500) bounds the history read.

Nothing is recorded: complete the story with `story complete-step` until it closes, and, when a started delivery exists, a person acknowledges the merge with `autonomy delivery reconcile`. `mode: off` turns the check off. When no base branch can be found, `merged_but_open_check` says so.

A story found merged while its records show it ready is never ready to start: `status`, `orchestrate status`, and `orchestrate plan` list it as `merged_open` (`summary.merged_open`, `merged_open_work` in `status`), and no tool suggestion names it (`merge_drift.open_state: available` keeps the earlier behaviour). When this branch has none of its work records (no claim, no completed step), the item carries `records_absent` and `merged_by` (the merged-in commit's author and branch), the advice says to recover the records from that computer with `story publish-records`, and `story claim` is refused with `STORY_ALREADY_MERGED`; only a person may claim it anyway (`--force --reason`, human or CI actor).

### Story records travel with the pull request

`orchestration_policy.story_records`:

| Key | Default | Meaning |
|---|---|---|
| `in_branch` | `include` | `git.commit`, `git.push`, and `pull_request.*` accept the story's records (`.sdlc` paths that name the story or no other story) outside the code's write scope; the action details list them as `story_record_paths`. `.sdlc/config.json`, caches, and another story's records stay refused. `exclude` restores the earlier behaviour. |
| `before_pull_request` | `warn` | `pull_request.create` and `pull_request.update` check that the head carries `.sdlc/stories/<id>/claim.json` and a completed step: `warn` lists what is missing (`story_records_missing`), `refuse` refuses the checkpoint, `off` skips the check. |
| `publish_branch_prefix` | `sdlc-records/` | Branch that `story publish-records` pushes. |
| `publish_pull_request` | `off` | `github-cli` opens the pull request of that branch with the GitHub CLI; `off` only pushes it. |

`story publish-records --id <story>` publishes what the story's work left on this computer after its pull request (final receipt, release of the claim, later steps): it fetches the remote base branch, builds one commit on top of it (or of an earlier unmerged publication) with the story's records the base branch lacks, through a private index, and pushes it as `<prefix><story>`. The checkout, its index, and its branches are not changed. A record the base branch changed after this work started is left out and listed as `skipped`. Nothing is ever deleted on the base branch.

## Claims Seen From Other Computers

`status` and `orchestrate status` show, for each claim held on another computer:

- the agent label, plus the git `user.name` when `orchestration_policy.claim_identity.git_user` is true, and the computer's label when the environment variable named by `claim_identity.host_label_env` (default `AGENTIC_SDLC_HOST_LABEL`) is set on the claiming computer. Nothing personal is recorded by default: a shared claim is an immutable record every reader of the remote sees, and the host name is never read;
- its last sign of life, read from git (`orchestration_policy.claim_activity.mode: git`): the last commit on the claim's branch as the remote has it, and how many commits that branch is ahead of the base branch. There is no heartbeat. `claim_activity.idle_after_seconds` marks a claim idle once that commit is older; it is a notice and never frees the story.

A claim is stale when it expires (`claim_policy.default_ttl_seconds`, 24 hours by default) or, when set, once it is older than `orchestration_policy.stale_claim_after_seconds`; both are compared with the reading computer's clock. Claim records on the remote live under `refs/agentic-sdlc/claims/` (`git ls-remote origin 'refs/agentic-sdlc/claims/*'`); `refs/agentic-sdlc-shared/` is only this clone's local copy of the records it has seen. A record gone from the remote stays in that copy as evidence and is reported as a problem, but no longer counts as a held claim; a claim file that came with git whose claim the remote ended or no longer has is reported as outdated and the story counts as free.

## Reserve A Story

```bash
node bin/agentic-sdlc.mjs story reserve --root <project> --id ST-001 --agent <name> --expires-in 3d --branch feature/ST-001
node bin/agentic-sdlc.mjs story release --root <project> --id ST-001
```

`story reserve --id <story> --agent <name> [--expires-in <90m|12h|3d|1w>] [--expires-at <ISO time>] [--branch <planned-branch>]` books a story before it can start. It needs no task start and no satisfied dependency, and writes nothing in the project. The reservation is a shared claim record marked `"reservation": true` under `refs/agentic-sdlc/claims/<story>/<epoch>/claim`; the computer's ownership is kept in `refs/agentic-sdlc-local/reservations/<remote>/<story>/<epoch>`, never pushed or fetched.

- Other computers see "reserved by X until Y" in `status` and `orchestrate status`; their `story claim` and `story reserve` are refused (`STORY_CLAIM_HELD_ELSEWHERE`). A person takes it over with `story claim --force --reason "<why>" --actor-type human`.
- The reserving computer's `story claim` converts it: the reservation epoch gets a release with status `transferred`, and the claim takes the next epoch.
- It always expires: default `orchestration_policy.reservation.default_expires_in_seconds` (86400), maximum `max_expires_in_seconds` (2592000). An expired reservation frees the story by itself.
- `story release --id <story>` ends a reservation; one made on another computer needs a person and `--reason`.
- Refused with `STORY_RESERVE_NOT_SHARED` when claims are not shared (no remote, or `coordination.mode: local_only`) and when the remote cannot be reached.

## Check A Story Before Starting It

```bash
node bin/agentic-sdlc.mjs story availability --root <project> --id ST-001 --json
```

Read-only: it only updates the remote-tracking branches with a fetch, unless status sync is off (`orchestration_policy.status_sync.mode: off` or `AGENTIC_SDLC_STATUS_SYNC=off`). Run it right before `task start`. It returns `verdict` (`free`, `claimed_here`, `reserved_here`, `reserved_elsewhere`, `claimed_elsewhere`, `finished`, `remote_work_without_claim`, `untrustworthy`), `safe_to_start` (true only for `free`, `claimed_here`, `reserved_here`), `holder`, `expired_reservation`, `completed`, and `remote_work`.

For a story nobody claimed or reserved, a remote-tracking branch whose name names the story id (`ST-1` does not match `ST-10`; a longer id wins) and that has commits not yet on the base branch (`orchestration_policy.merge_drift.base_branch`, or the remote's default branch) produces a plain-language warning, also in `status` and `orchestrate status` as `unclaimed_remote_work`. It never blocks. Configuration, under `orchestration_policy.unclaimed_remote_work`:

- `mode`: `git` (default) or `off`.
- `pull_requests`: `off` (default) or `github-cli`, which reads open pull requests whose title or head branch names the story through `gh pr list`, when installed and signed in; a failure becomes a warning note.
- `recent_within_seconds`: `null` (default) or 60 to 31536000.

## Print The Pull-Request Checks Table

Use `autonomy delivery checks` to print the checks that were actually recorded for one pull-request delivery as a Markdown table, ready to paste into the pull-request description. It only reads: nothing is re-run, repaired, or approved.

```bash
node bin/agentic-sdlc.mjs autonomy delivery checks --root <project> --id AUT-PR-001
node bin/agentic-sdlc.mjs autonomy delivery checks --root <project> --id AUT-PR-001 --format json
node bin/agentic-sdlc.mjs autonomy delivery checks --root <project> --id AUT-PR-001 --locale it
```

The host writes the description, so put the table in it when authorizing `pull_request.create` or `pull_request.update`. Both authorizations return the table as `pull_request_body_checks.markdown` (the same bytes the command prints) with the command that regenerates it as `pull_request_body_checks.command`; when a record cannot be read, `markdown` is `null` and `unavailable_reason` says why, and the authorization still succeeds. The table is built when the action is authorized, so record the test, scan, and review evidence first. A typical hand-off is `node bin/agentic-sdlc.mjs autonomy delivery checks --root <project> --id AUT-PR-001 > checks.md`, then a description built from the summary text followed by `checks.md`.

| Row | Read from | Passes when |
|---|---|---|
| Tests | `test-run:v1` records of the delivery's story, recorded while the delivery was running | The latest run of that command passed and was made at the current commit. One row per distinct command; a later failure replaces an earlier pass, and a run made before a later commit is `NOT RUN` until it is run again. |
| Smoke tests | The same records, when recorded with `test record --framework smoke` | The latest smoke run passed. |
| Secret scan | `secret-scan:v1` records for the delivery | The latest scan that still covers the current head, delivery base, and uncommitted work is clean. A scan of an earlier state is `NOT RUN`. |
| Code review gate | `code-review:v1` records for the delivery profile | An independent reviewer approved the current head. Only the author's review, or a review of an earlier head, is `NOT RUN`. Shows whether this delivery's merge requires a review (the user's answer for the story, or `gate_policy.merge_requires_code_review`). With no review recorded the row is `NOT RUN`, whether or not the merge needs one; the requirement itself is checked only at merge. |
| Strict gate, Lifecycle-complete gate | `.sdlc/gates/<story>-strict.json` and `-final.json` | The receipt exists, matches its schema and its own hash, and is for this story. |
| Standing approval | The standing approval the delivery was proposed under (row appears only then) | A delivery slot is recorded for this delivery and the approval is not `invalid` or `revoked`. |
| Budget decision | The start receipt's recorded autonomy decision and the contract | An execution budget is bound and the start decision was not stopped by it. With no budget bound, the row is `NOT RUN`. |
| External merge | `external-merge.json` of the delivery (row appears only then) | A person acknowledged a merge made outside the plugin with `autonomy delivery reconcile`. The row shows the pull request, merge commit, who merged it and when, and who acknowledged it. |

Each row carries a plain-text marker, `[PASS]`, `[FAIL]`, or `[NOT RUN]` (`[SUPERATO]`, `[FALLITO]`, `[NON ESEGUITO]` with `--locale it`). A check with no record is `NOT RUN`, never a pass. A record whose own hash no longer matches is left out and counted in a closing note. The table is a report of recorded facts, not a gate: the strict and lifecycle-complete gates stay the authority, and a gate receipt is shown as sealed, not re-evaluated.

When the delivery's head branch is not checked out, no head-dependent check (tests, smoke tests, secret scan, code review) can pass; a failure is still shown. Absolute paths in a recorded command are shown root-relative when they lie under the project and as `<path>` otherwise. Evidence is linked only as a plain project-relative path (for example `.sdlc/tests/ST-001-run.json`); an absolute path, a parent-relative path, or a URL is dropped. The model passes through the project's privacy redaction before printing, so a credential in a recorded command appears as `[REDACTED]`; the stored record keeps what ran. The output is the table alone, with no envelope, correlation ID, or clock reading, so identical records give identical bytes. `--json` and `--format json` print the same language-neutral document (`pull-request-checks:v1`); `--json` with `--format markdown` is refused. A local release is refused: the table is built for pull-request deliveries.

## Append Trace

```bash
node bin/agentic-sdlc.mjs trace append --root <project> --story ST-001 --type test --outcome passed --summary "Unit tests passed" --evidence .sdlc/tests/ST-001-test-run.json --actor <host-agent> --actor-type agent
node bin/agentic-sdlc.mjs trace append --root <project> --story ST-001 --type implementation --summary "Implemented a requested change" --actor <host-agent> --actor-type agent --requested-by antonioantenore --requested-by-type human --authorized-by antonioantenore --authorized-by-type human --request-summary "Implement the requested feature"
node bin/agentic-sdlc.mjs trace append --root <project> --story ST-001 --type implementation --summary "Added a local launcher" --input-summary "Approved contract" --output-summary "Installed observe command" --rationale-summary "Keep evidence local" --alternative "Hosted dashboard" --explanation "The plugin can now display recorded delivery lineage locally." --explanation-kind codex-generated
```

Valid trace types: `assumption`, `decision`, `gate`, `claim`, `handoff`, `implementation`, `lock`, `release`, `risk`, `sync`, `test`.
`--evidence` must name a file inside the project or an `http(s)` URL: absolute paths elsewhere, `../` escapes, symlinks that leave the project, and other URI schemes such as `file:` are refused, accepted paths are stored project-relative, `http(s)` URLs are kept unchanged as references (never fetched or fingerprinted), and a path to a file that does not exist yet is recorded as a path only with an "evidence not verified" notice (`evidence_unverified` in JSON).

Verify the sealed history (read-only; exits `1` and explains recovery when a file changed):

```bash
node bin/agentic-sdlc.mjs trace verify --root <project>
node bin/agentic-sdlc.mjs trace verify --root <project> --json
```

When `trace append` reports `TRACE_INTEGRITY_VIOLATION`, run `trace verify` and tell the user which file changed. Only for `violated`, and only if the change was not intended, back up `.sdlc/traces` (restoring discards events recorded since the last commit) and restore it from version control before retrying. `recovery_needed` is an interrupted recording that the next recorded event repairs automatically; do not restore anything. `unverifiable` is a file above the 64 MiB verification limit, not tampering. Never edit history files by hand. `TRACE_HISTORY_TOO_LARGE` means a history file exceeds the 8 MiB read limit; see `docs/how-it-works.md#history-size-limit`. `CONFIG_MISSING` and `PROJECT_RECORD_INVALID` mean `.sdlc/config.json` or `.sdlc/project.json` must be restored (from version control, or by copying the bundled defaults file the message names when the lock proves the configuration was the defaults); do not recreate a customized configuration from defaults.
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

With `--json`, standard output contains that URL and its per-run access token: do not paste it into bug reports, issues, or shared logs.

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

Do not present an intermediate strict result as the final discovery-to-operations certificate. Both forms return non-zero when blocking errors are found. Use `--out` to persist JSON or Markdown gate evidence.

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

When `output link` fails with a duplicate-output error, either use `--mode delta` (with `--base-artifact`) or `--mode reuse`, or record an approved exception in the same call: pass a new `--decision-id` plus `--rationale` (or `--approval-evidence`), `--actor-type human` and `--approval-source`. In short, run `output link` with `--decision-id` and `--rationale` as a human or CI actor. The CLI records the approved decision in the registry:

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

`budget meter start` lists the budget metrics the adapter cannot measure (for
example cost under the Codex-session meter); `budget status` shows those as
`not measured` instead of zero. Without `CODEX_THREAD_ID` (a host that does not
run Codex tasks), pass `--thread-id`, use an enabled `codeburn` adapter, or
record usage manually.

## Budget Usage, Exceptions, And Stopping

```bash
# Manual usage: plain whole numbers (decimals only for --cost-amount), only for metrics in the budget.
node bin/agentic-sdlc.mjs budget usage record --root <project> --proposal ASSESS-001 --input-tokens 1200 --output-tokens 300
node bin/agentic-sdlc.mjs budget status --root <project> --proposal ASSESS-001

# At exception_pending: extend (approver's own --summary is required) ...
node bin/agentic-sdlc.mjs budget amend --root <project> --proposal ASSESS-001 \
  --budget-json '{"limits":{"tokens":{"soft":350000}}}' --reason "<why more is needed>" \
  --actor-type human --approval-source explicit-user --summary "<the person's decision>"

# ... or stop, keeping already linked output as a non-released partial result.
node bin/agentic-sdlc.mjs assessment proposal cancel --root <project> --id ASSESS-001 \
  --reason "<why the work stops>" --actor-type human --approval-source explicit-user --summary "<the person's decision>"
```

`budget status` prints `used / soft (x%), hard (y%)` per metric with its unit or
currency, warnings at the configured percentages of soft and hard limits, and
`not measured` for metrics no receipt has reported. Under `audit_only`, amend and
cancel outputs carry `authority_note`: show it, and never present the decision
as verified. Usage receipts are append-only and bound into a ledger; a deleted or
edited receipt stops budget status, recording, and completion until it is
restored. Shipped default limits are soft-only; hard limits need the exact
metering setup in `docs/limits-and-metering.md`.

## Delivery Cost And Lead Time

```bash
# Once the delivery is approved: record usage against it, with a meter or by hand.
node bin/agentic-sdlc.mjs budget meter start --root <project> --delivery AUT-FLAG-12 --adapter codeburn
node bin/agentic-sdlc.mjs budget meter record --root <project> --delivery AUT-FLAG-12 --adapter codeburn
node bin/agentic-sdlc.mjs budget usage record --root <project> --delivery AUT-FLAG-12 --input-tokens 1200 --output-tokens 300 --cost-amount 0.42 --currency USD
# Cost, tokens, and lead time of one delivery; status and autonomy delivery status show them too.
node bin/agentic-sdlc.mjs budget status --root <project> --delivery AUT-FLAG-12
```

`--delivery <profile-id>` replaces `--proposal` for a delivery; assessments are
unchanged. Usage is accepted from approval until close or revocation. Receipts
bind to the delivery's measure-only meter plan, are validated against the
recorded history before they are written, and are chained into the delivery's
ledger; a deleted or edited receipt makes its cost unreadable until restored. A
delivery records cost in one currency (the standing approval budget's, else the
first `--currency`, else the meter's); a different currency is refused. Exact
values need a trusted signed receipt imported with `--receipt-file`, whose
signature is verified for every metric it carries; an adapter observation is
recorded only by `budget meter record`. One baseline per meter adapter; start it
after approval and before `task start`. The CodeBurn window is derived from the
delivery (approval day to the end of its validity), so `--project`, `--from`,
`--to`, and `--provider` are refused with `--delivery`. Usage can still be
recorded after close, for a final reading; a reading dated in the future is
refused. A delivery with nothing recorded reads `not measured`, a hand-declared
cost is shown as declared, and the Change Observatory labels a meter's figure as
not verified there. Never edit files under `.sdlc/autonomy/metering/`.

Lead time comes only from existing records: proposed, approved, work started,
first action, and released, ready for review, or closed, with the time between
each; waiting for a person runs from a direct-approval proposal to its approval
and from a recorded standing-approval fallback to the person's confirmation of
that step. Present these figures in plain language and keep receipt ids as
technical detail.

## Activity Reports

```bash
node bin/agentic-sdlc.mjs report activity --root <project> --since 3d --view business --out .sdlc/reports/activity.md
node bin/agentic-sdlc.mjs report activity --root <project> --since 3d --view dev --json
node bin/agentic-sdlc.mjs report activity --root <project> --since 12h --view agent-verbose --story ST-001
node bin/agentic-sdlc.mjs approval requests --root <project> --story ST-001 --json
node bin/agentic-sdlc.mjs report query --root <project> --query-json '{"intent":"find_records","subjects":["activity"],"filters":{"event_type":["decision"]},"time":{"since":"30d"}}' --json
node bin/agentic-sdlc.mjs report query --root <project> --query-json '<canonical-report-query-json>' --json
```

Free text passed with `--query` or `--text` is not searched: the command answers "No answer: this question needs a structured query" and shows a working `--query-json` example. Normalize the question into a structured query first.

Both reports verify history integrity and open with a "history changed unexpectedly" warning when it fails, apply the project's redaction rules when presenting or writing `--out` files, neutralize terminal control characters in recorded text, and report how many history lines could not be read. A `--since` later than now needs an explicit later `--until`, because `--until` defaults to now.

Activity reports reconstruct what happened from canonical trace files only. Business view focuses on decisions, validation, risk, handoffs, implementation, and release. Dev view includes evidence, branch/SHA, related IDs, and source lines. Agent-verbose view includes raw trace, git, and run metadata for audit.

Use `approval requests` before continuing when a baseline, capability profile, capability recommendation, output template, contract clarification, contract approval, or canonical output link needs human agreement. It also lists proposals that wait for a person (proposed requirements, breakdowns, dependency orders, delivery autonomy profiles, workflow definitions and overlays, and standing approvals) with the exact approve command; `status` counts them as pending decisions. Proposal commands for those artifact types return an `assistant_message` and `approval_request` too; show those when available instead of saying only that artifacts were prepared. The command is intentionally user-facing and returns `assistant_message` plus `assistant_message_presentation`. Agents should translate and contextualize `assistant_message` in the active chat language when `translate_to_chat_language` is true. Present plain-language meaning first: baseline means trusted project context, capability profile means tools-and-permissions boundaries, capability recommendation means concrete tool choices, output template means assessment/output format, and contract means the work brief. Preserve IDs, paths, commands, status codes, and schema keys only as technical detail when needed. Present what must be reviewed, why it matters, what approval means, whether more information is needed, and what will happen next. Do not reduce approval to a bare question, a file link, or a list of artifact IDs; summarize relevant baseline report, capability records, template, contract, and source-list contents directly in chat. For output-template approvals, show the sections, template content when useful, delivery/presentation options, recommended delivery, and delivery question before asking. Approval scope is exact: a user response approves only the displayed request, not later artifacts. Then stop until the user approves, answers, or asks for changes.

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
