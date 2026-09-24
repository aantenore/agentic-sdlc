# Configurable workflows

Agentic SDLC can follow different agreed sequences instead of forcing every request through the same software-delivery process. For example, a new feature can use discovery through release, a small change can use intake through closure, and an assessment can keep its two normal approval moments.

The practical rule is simple: choosing a process decides **which steps come next**. It does not decide **what the agent is allowed to do**. For each pull request or local release, the user still chooses separately whether the agent must ask at every step, may continue between agreed review moments, or may finish that one delivery inside the displayed limits.

Once work starts, later edits to the general process do not change that run. A project-specific adjustment must be reviewed before use, and it applies only to new runs. The technical sections below call the reusable process a *definition*, the project-specific adjustment an *overlay*, and one running use of it an *instance*.

## Built-in processes

Four preset identifiers are shipped with the plugin. `software-project` has
three included definition versions so existing work can remain reproducible
while new work uses stronger lifecycle governance:

| Preset | Version | Intended use | Stable journey |
| --- | --- | --- | --- |
| Software project | v3, current | New feature delivery governed by phase-bound canonical story evidence | `discovery`, `analysis`, `design`, `implementation`, `validation`, `release`, `operations` |
| Software project | v2, compatibility | Replay or resume a governed instance pinned to canonical evidence v1 | The same seven phases and canonical guards, with legacy all-due outputs and unscoped evidence |
| Software project | v1, legacy | Replay or resume an instance already pinned to the original sequential definition | The same seven phases, without canonical transition guards |
| Change request | v1 | A bounded change with review and verification | Intake, impact review, approval, implementation, validation, closure |
| Technical assessment | v1 | The existing guided assessment | Project context, complete proposal, execution, verification, completion; exactly two normal user checkpoints |
| Generic governed process | v1 | A reusable approval-and-execution skeleton | Draft, review, approval, execution, verification, completion |

`software-project` v1 and v2 are intentionally preserved with their original
definition hashes and behavior. A pinned instance is never silently upgraded:
v1 remains guardless, while v2 continues to produce and accept only
`workflow-canonical-evidence:v1`. Use them only when compatibility with an
existing stored instance requires that exact definition; choose v3 for new
software delivery.

Version 3 keeps the same phase identifiers and order, binds the instance to one
story, and derives its guard decisions from phase-bound canonical project
records:

| Transition | Canonical evidence required |
| --- | --- |
| `discovery` → `analysis` | The story's referenced requirement is currently approved with matching content |
| `analysis` → `design` | No additional transition guard |
| `design` → `implementation` | The story's implementation contract is currently approved and matches the story |
| `implementation` → `validation` | Every output due through the current workflow phase is linked with valid current verification; later-phase outputs remain deferred |
| `validation` → `release` | The story has passing intermediate strict-gate evidence |
| `release` → `operations` | No additional transition guard; incident and feedback records are tracked, never blocking |

The runtime loads requirement, contract, output, strict-gate, delivery-profile,
and delivery-close records through the governed project reader, then seals one
snapshot using the evidence schema pinned by the immutable effective
definition. A v2 workflow produces and accepts only canonical evidence v1,
including when it resumes and appends a new transition. A v3 workflow produces
and accepts only phase-bound canonical evidence v2; rewriting or presenting a
v3 event as v1 is rejected. Canonical evidence cannot predate its bound
checkpoint or postdate the transition event that records it. A caller cannot
bypass a canonical guard by claiming success in `--guard-input-json`; missing,
stale, mismatched, modified, unsuccessful, or wrong-version evidence fails
closed. The final discovery-to-operations certificate remains the story gate.

The two gate receipts are deliberately different. A passing ordinary strict
story gate writes `.sdlc/gates/<story-id>-strict.json` as
`workflow-strict-gate-receipt:v2` for a current v3 story-bound workflow.
Version 2 binds the receipt to the exact instance, effective definition,
durable checkpoint, and current phase, so advancing the workflow makes an
earlier receipt unusable by a later canonical guard. A workflow pinned to the
compatibility v2 definition continues to write the unscoped v1 receipt required
by its evidence-v1 contract; a legacy story with no workflow may also receive a
readable v1 receipt. An unscoped receipt cannot satisfy a v3 canonical
transition guard. The intermediate receipt proves that current validation
evidence is ready for its guarded transition, but it is not a final lifecycle
certificate.
After that transition, complete the exact delivery,
append its passing release trace, complete the release step, transition to
`operations`, complete the `operations` step — a plain completion marker,
never gated on an incident or feedback record existing — and release the
completed story claim. The lifecycle-complete
gate replays the selected workflow instance, verifies its immutable header,
event hashes, durable checkpoint, and matching audit-trace chain, and requires
workflow start before task start, each phase entry before that phase's
completion, and each next entry after the prior completion. Entry into the
configured final state (`operations`) must precede both release evidence and
terminal delivery. Only then does it write
`.sdlc/gates/<story-id>-final.json` as
`workflow-final-gate-receipt:v3`. Historical v1 receipts remain readable for
an already pinned legacy run. Pre-freshness v2 receipts require explicit
recertification; only v3 binds the terminal workflow and its current
story-scoped freshness proof.

A v3 receipt that still contains `workflow-final-freshness-proof:v1` is also
historical-only: status rejects it as the current certificate. Preserve it in
repository history if required, then rerun
`gate check --strict --story <story-id> --lifecycle-complete` on the unchanged,
reviewed terminal state to reseal `workflow-final-freshness-proof:v2`. The v2
proof permits only a monotonic descendant-history transition from the certified
HEAD identity to the exact certified working-tree identity. Transient third
identities, a later return to the old identity, replace refs, grafts, inherited
alternate Git state, shallow history, hidden index flags, partial staging, or
current governed path drift fail closed. Untracked paths inside the approved
scope are inventoried even when `.gitignore`, `.git/info/exclude`, or a global
exclude file matches them.

The examples in this guide use the npm/package bin shim `agentic-sdlc`. A Codex
plugin installation does not create that global executable; use
`node <plugin-root>/bin/agentic-sdlc.mjs` followed by the same arguments:

```bash
agentic-sdlc gate check --strict --story ST-TRIP-POLICY-001
agentic-sdlc workflow instance transition \
  --id DELIVERY-TRIP-POLICY-001 \
  --to release \
  --request-id trip-policy-release-1
agentic-sdlc gate check --strict --story ST-TRIP-POLICY-001 --lifecycle-complete
```

If a story retains more than one immutable story-bound workflow run, the
current run is selected deterministically as the newest `created_at` value,
with the immutable instance ID as a stable tie-breaker. Older runs remain
historical evidence. The selected run must pin the exact current project phase
order; this rule applies equally to the included v1/v2/v3 processes and approved
custom definitions. Start the selected story-bound instance before `task
start` and before the first completed step. The runtime rejects a post-hoc
instance, and final certification requires the exact instance reference stored
by task start. If the configured order differs from the seven stock phases, use
an approved custom story-bound definition with that exact order.

For a current canonical story-bound workflow, a transition cannot leave its
current phase until the matching `story complete-step` record exists. Completion
is bound to its sealed story trace and exact file hash, so a missing, stale, or
manually edited step blocks both transition and readiness. `workflow instance
status` exposes `current_phase_completion`, its blockers, and an empty
`ready_next_states` list until the phase is safe to leave. Idempotent retries of
an already recorded transition remain no-ops.

The technical-assessment preset complements the existing
`assessment-proposal:v1` and `assessment-workflow:v1` records; it does not
replace their files, commands, JSON fields, or two-checkpoint behavior.

## First custom phase: copy, edit, approve, start

The plugin ships one self-contained project-template directory for the current
`software-project` v3 lifecycle plus an `integration-review` phase between
implementation and validation:

```text
templates/workflow-software-project-v3-integration-review/
  README.md
  sdlc-config.json
  workflow-definition.json
```

For a new local project, use the directory during initialization. `init`
validates the complete config, creates all seven phase contracts, and pins the
config hash in the same bootstrap:

```bash
PLUGIN_ROOT=/absolute/path/to/agentic-sdlc-codex-plugin
PROJECT_ROOT=/absolute/path/to/project

node "$PLUGIN_ROOT/bin/agentic-sdlc.mjs" init \
  --root "$PROJECT_ROOT" \
  --project-name "Local project with integration review" \
  --template-dir \
    "$PLUGIN_ROOT/templates/workflow-software-project-v3-integration-review"

node "$PLUGIN_ROOT/bin/agentic-sdlc.mjs" config status \
  --root "$PROJECT_ROOT"
```

Use the same `--template-dir` with `onboard existing-project` when the
repository already contains useful code but has no `.sdlc/` yet. This is the
recommended path: no post-init JSON edit or hidden phase copy is needed.

If a plain default `init` was just completed and no governed work has started,
the companion config can replace that untouched default in full. Review the
exact files first, then let `config migrate` bind the complete replacement to
its displayed plan hash:

```bash
diff -u \
  "$PROJECT_ROOT/.sdlc/config.json" \
  "$PLUGIN_ROOT/templates/workflow-software-project-v3-integration-review/sdlc-config.json"

cp \
  "$PLUGIN_ROOT/templates/workflow-software-project-v3-integration-review/sdlc-config.json" \
  "$PROJECT_ROOT/.sdlc/config.json"

node "$PLUGIN_ROOT/bin/agentic-sdlc.mjs" config migrate \
  --root "$PROJECT_ROOT"

node "$PLUGIN_ROOT/bin/agentic-sdlc.mjs" config migrate \
  --root "$PROJECT_ROOT" \
  --apply \
  --plan-hash <hash-shown-by-the-preview>
```

Do not replace a customized or active project's full config with this
companion. In that case, review and merge the intended phase and autonomy
differences under the normal [Configuration safety](configuration-safety.md)
procedure.

`--definition-file` deliberately reads only a file inside the target project.
Copy the definition there after configuration is pinned, so the reviewed
proposal never depends on a mutable file inside the plugin installation:

```bash
cp \
  "$PLUGIN_ROOT/templates/workflow-software-project-v3-integration-review/workflow-definition.json" \
  "$PROJECT_ROOT/workflow-software-project-v3-integration-review.json"
```

Edit the project copy before proposing it. These are the author-owned input
fields:

| Input field | What to review or edit |
| --- | --- |
| `label`, `description` | Human explanation of the process |
| `initial_state` | First state; it must exist in `states` |
| `states` | Stable IDs, labels, terminal marker, and non-executable metadata |
| `transitions` | Stable IDs, `from`/`to`, labels, allowlisted guards, and metadata |
| `phase_order` | Exact project lifecycle order |
| `normal_checkpoints` | Normal process review moments; this does not select delivery autonomy |
| `metadata` | Story binding, canonical evidence version, and descriptive provenance |

Do not add the following fields to the editable input. The CLI derives or
overrides them from the command and the recorded decision:

| CLI-derived field | Source |
| --- | --- |
| `id` | `--id` |
| `version` | `--definition-version` |
| `kind`, `schema_version`, `status` | Canonical proposal builder |
| `created_at` | Proposal time |
| `approval` | `workflow definition approve` |
| `definition_hash`, `hash_algorithm` | Canonical content hashing |

The definition and companion config deliberately contain the same exact
seven-phase order. A mismatch fails before an instance starts.

Propose the project-local copy, inspect it, approve that exact version, and
start it for an existing story:

```bash
node "$PLUGIN_ROOT/bin/agentic-sdlc.mjs" workflow definition propose \
  --root "$PROJECT_ROOT" \
  --id software-project-integration-review \
  --definition-version 1 \
  --definition-file workflow-software-project-v3-integration-review.json \
  --summary "Add an explicit integration review before validation"

node "$PLUGIN_ROOT/bin/agentic-sdlc.mjs" workflow definition show \
  --root "$PROJECT_ROOT" \
  --id software-project-integration-review \
  --definition-version 1

node "$PLUGIN_ROOT/bin/agentic-sdlc.mjs" workflow definition approve \
  --root "$PROJECT_ROOT" \
  --id software-project-integration-review \
  --definition-version 1 \
  --actor-type human \
  --approval-source explicit-user \
  --summary "Approve the displayed seven-phase workflow"

node "$PLUGIN_ROOT/bin/agentic-sdlc.mjs" workflow instance start \
  --root "$PROJECT_ROOT" \
  --id DELIVERY-ST-001 \
  --definition software-project-integration-review \
  --definition-version 1 \
  --story ST-001
```

The template retains the v3 canonical guards: approved requirement before
analysis, approved contract before implementation, linked outputs through
integration review before validation, and a passing intermediate strict gate
before release. The story must complete `integration-review` before the
workflow can enter validation.

When a `supervised` delivery profile checkpoints both the initial claim and a
step completion, record separate one-use grants after the person approves
each exact operation. Claim authority is story-scoped; completion authority is
bound to the story and configured step:

```bash
node "$PLUGIN_ROOT/bin/agentic-sdlc.mjs" authorization grant \
  --root "$PROJECT_ROOT" \
  --id AUTH-ST-001-CLAIM \
  --scope "Allow one claim for ST-001 only" \
  --allow-use story.claim=ST-001 \
  --max-uses 1 \
  --actor-type human \
  --approval-source explicit-user \
  --summary "Approve one story claim for ST-001"

node "$PLUGIN_ROOT/bin/agentic-sdlc.mjs" authorization grant \
  --root "$PROJECT_ROOT" \
  --id AUTH-ST-001-INTEGRATION-REVIEW-COMPLETE \
  --scope "Complete integration-review for ST-001 only" \
  --allow-use story.complete-step=ST-001.step.integration-review \
  --allow-artifact-type integration-review-report \
  --max-uses 1 \
  --actor-type human \
  --approval-source explicit-user \
  --summary "Approve the integration-review completion for ST-001"
```

Pass `AUTH-ST-001-CLAIM` only to `story claim`. Pass
`AUTH-ST-001-INTEGRATION-REVIEW-COMPLETE` only to
`story complete-step --id ST-001 --step integration-review`. Create a new grant
ID and compound subject such as `ST-001.step.validation` for every later
completion. Legacy story-wide completion subjects remain readable but produce
a warning; do not use them for new work. These grants do not approve the
contract, task start, output link, release, or any other step.

The example permits the concrete type `integration-review-report`. Replace it
with the exact type required by the approved contract. Every type passed to
`story complete-step --type <type>` must also appear once as
`--allow-artifact-type <type>` on that step's grant. Omit the artifact flag
only when the completion passes no `--type`; evidence paths alone do not need
artifact-type authority.

## Definitions, overlays, and running instances

A workflow definition contains stable state and transition identifiers. It is versioned and content-hashed. Approval applies to one exact version, so a later edit becomes a new proposal instead of silently changing active work.

An overlay is a limited, versioned customization. It may change human labels, descriptions, metadata, and parameters for an already allowed guard. It cannot change state or transition identifiers, the initial state, transition direction, ordered phases, or recorded history. The CLI explains the effective result before an overlay is approved.

Starting an instance pins three hashes:

- the approved definition version;
- the approved overlay version, when one is selected;
- the effective definition produced from both.

Updating a definition or overlay therefore affects only new instances. A running instance continues against the exact process it started with.

## Append-only history

Each transition is appended to `events.jsonl`. Events carry a sequence number, the preceding event hash, their own content hash, an actor, a timestamp, and an idempotency key. `checkpoint.json` records the last fully accepted sequence, state, event hash, and cumulative audit-trace hash. Replay validates the complete event chain and the ordered full content of its matching audit records against that durable checkpoint before calculating current status.

The engine rejects an invalid transition, an unknown guard, a reused idempotency key with different intent, an unexpected sequence, a timestamp that moves backwards, and evidence that has been modified, reordered, duplicated, appended without completing its checkpoint update, or truncated. Custom guards are names from an allowlist plus validated parameters; workflow data is never executed as JavaScript, a module import, or a shell command.

Start first records one stable intent, writes the instance into same-filesystem staging, validates every staged byte, and only then publishes the complete directory. The start record remains until the matching audit trace is durable. A retry with the exact same intent can therefore finish an interruption after a process termination without creating a second instance; status and transitions cannot use the instance while that start record remains.

A transition holds one instance lock and records a hash-bound `pending-transition.json` before changing canonical history. The journal anchors the exact byte prefix of both the event stream and the project trace. It appends and synchronizes the event, atomically replaces the checkpoint, records one deterministic trace, and removes the pending record only after all three agree. If a crash leaves only the beginning of the one event or trace line owned by that journal, recovery may truncate and rewrite only that exact suffix. Any different or unrelated suffix stops recovery without changing it.

If a crash interrupts that sequence, status and explanation remain read-only and stop safely: they do not guess a state or repair evidence. The primary message simply asks the operator to repeat the same transition toward the same destination. The optional technical details retain the exact request identifier needed to validate the pending record against the pinned instance, the old checkpoint, the event, the new checkpoint, and the trace, then complete only the missing writes exactly once. A different retry cannot take over that recovery. If the pending record itself is invalid, or the event/checkpoint mismatch has no valid pending record, recovery requires restoring the instance files from one trusted copy. Deleting or rebuilding a checkpoint merely to silence the error is never accepted.

The runtime treats persistence as a commit protocol rather than a sequence of ordinary writes. It flushes each event, journal, checkpoint, and trace file through a write-capable handle and then flushes the containing directory before the next boundary. On POSIX local filesystems this includes the directory entry. Node does not provide the same directory-flush guarantee on every Windows filesystem: failure to open the directory, invalid paths, ACL failures during open, and sharing failures still stop the operation; after a directory was opened successfully, only the specific Windows errors that mean directory flushing is unsupported are accepted as a platform limitation. The file contents are flushed, but metadata durability after sudden power loss ultimately retains the guarantee of the host OS and filesystem.

Runtime validation also requires one matching start trace and exactly one matching transition trace for every accepted event, in the same order. A cumulative hash in the checkpoint binds the full content of those records, including attribution, evidence, outcome, Git/run context, and summary. This detects isolated audit edits and an event/checkpoint pair restored to an older state while its later audit trace remains. These are strong local consistency checks, not a claim that local files are impossible to rewrite: an administrator able to replace the checkpoint and complete project trace consistently can also replace the local evidence of the change. Preventing that stronger coordinated rollback requires an external append-only or host-signed anchor. Network shares and filesystems without reliable hard-link, atomic-rename, locking, and flush semantics are outside the crash-durability guarantee and should use such an external evidence store.

## Storage

Canonical records live under the target project:

```text
.sdlc/workflows/
  definitions/<definition-id>/v<version>.json
  overlays/<overlay-id>/v<version>.json
  instances/.starts/<instance-id>.json       # present only while an interrupted start awaits the exact retry
  instances/.staging/<instance-id>/...       # same-filesystem material prepared before publication
  instances/<instance-id>/instance.json
  instances/<instance-id>/events.jsonl
  instances/<instance-id>/checkpoint.json
  instances/<instance-id>/pending-transition.json  # present only while an interrupted transition awaits the same retry
.sdlc/traces/project.jsonl                    # start and transition audit records used by the cross-check
```

Definitions and overlays are immutable after approval. Instance headers are immutable after start. During normal execution the event stream is extended and its checkpoint is replaced under the same instance lock; neither record is accepted without the other. The pending record is a recovery journal, not a second source of current status.

## Command journey

Use focused help for the exact options supported by the installed version:

```bash
agentic-sdlc workflow definition list
agentic-sdlc workflow definition show --id software-project --definition-version 1
agentic-sdlc workflow definition show --id software-project --definition-version 2
agentic-sdlc workflow definition show --id software-project --definition-version 3
agentic-sdlc workflow definition propose --id my-process --definition-version 1 --definition-file workflow.json
agentic-sdlc workflow definition approve --id my-process --definition-version 1 --actor-type human --approval-source explicit-user --summary "I confirm these steps and checks"

agentic-sdlc workflow overlay propose --id labels-it --overlay-version 1 --definition my-process --definition-version 1 --overlay-file labels-it.json
agentic-sdlc workflow overlay approve --id labels-it --overlay-version 1 --actor-type human --approval-source explicit-user --summary "I confirm these project-specific labels and checks"
agentic-sdlc workflow overlay explain --id labels-it --overlay-version 1

agentic-sdlc workflow instance start --id change-184 --definition change-request --definition-version 1
agentic-sdlc workflow instance transition --id change-184 --to impact-review --request-id review-1
agentic-sdlc workflow instance status --id change-184
agentic-sdlc workflow instance explain --id change-184
```

For a new governed software project, pin v3 and its story explicitly:

```bash
agentic-sdlc workflow instance start \
  --id DELIVERY-TRIP-POLICY-001 \
  --definition software-project \
  --definition-version 3 \
  --story ST-TRIP-POLICY-001
```

Omitting `--definition-version` is not accepted when an instance starts.
Explicit version pinning keeps the chosen process reviewable even after a newer
preset is released.

Human output begins with the outcome, practical impact, any decision needed, what remains protected, and one next action. `--json` returns stable machine output. Internal hashes and record paths remain supporting detail rather than prerequisites for understanding the result.

## Local releases and pull requests

The workflow chosen for a requirement does not choose autonomy for a delivery. Every pull request or local release still receives its own non-reusable working choice, exact destination, allowed files, and protected-action receipts. A local release also keeps its own smoke test and rollback procedure. A new workflow version cannot reuse or widen an earlier delivery choice.
