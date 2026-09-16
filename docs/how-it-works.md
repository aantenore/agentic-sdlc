# How Agentic SDLC 0.14.0 Works

Agentic SDLC turns a natural-language request into a bounded, reproducible execution tranche. Codex handles conversation and reasoning; the CLI handles deterministic validation and state changes; the target repository keeps the evidence under `.sdlc/`.

The core rule is simple: **Codex may reason broadly, but it may write only what the approved requirement, current delivery unit, and exact authorization all allow.**

For the adjacent details, see [Limits and Metering](limits-and-metering.md), [Agent Interactions](agent-interactions.md), and the deeper [Architecture](architecture.md).

## One End-To-End Governed Delivery

The controls below form one lifecycle, not a menu of independent records.
Consider the same first-project request used in the README and Getting Started:
a configurable trip-policy module, verified and released only to a named local
destination, with no network or production access.

The technical chain for `ST-TRIP-POLICY-001` is:

1. **Discovery** records the inspected project context and separates observed
   facts from inference. It grants no write or delivery authority.
2. **Requirement** approves one immutable revision containing the configurable
   cost-limit behavior, acceptance criteria, exclusions, constraints, and
   autonomy ceiling.
3. **Contract** binds the story to that approved requirement, required output,
   source and test paths, capabilities, checks, delivery profile, and write
   scope.
4. **Story and workflow** start one `software-project` v3 instance bound to
   `ST-TRIP-POLICY-001` before task start or any completed step. A custom
   `phase_order` requires an approved story-bound definition with that exact
   order. Its transitions consult canonical requirement,
   contract, output, gate, and delivery records rather than trusting
   caller-supplied guard claims. The immutable task start must bind the current
   approved contract before any worker can claim the story.
5. **Implementation and validation** claim the started story, write only the
   intersection of approved scopes, link the real output, record the latest
   test and verification evidence, and complete each phase before entering the
   next. A newer failure supersedes an older passing trace.
6. **Release entry** runs the ordinary strict validation gate and moves the
   bound workflow into `release`.
7. **Release** only then closes the exact local delivery as `released`, appends
   the passing release trace, and completes the release step after build, smoke
   test, destination, and rollback evidence agree. Repository publication and
   production remain separate.
8. **Final certification** releases the completed story claim, then evaluates
   the complete story after that release:

   ```bash
   agentic-sdlc gate check --strict --story ST-TRIP-POLICY-001 --lifecycle-complete
   ```

Only that lifecycle-complete form is the final story certificate. It binds all
configured phases, current approvals, required output, latest test evidence,
terminal delivery, and release evidence into the final receipt. A strict check
run earlier may support an intermediate decision but must not be presented as
proof that discovery-to-release delivery is complete.

Final receipts sealed with `workflow-final-freshness-proof:v1` are historical
evidence, not a current certificate. On an unchanged, still-valid terminal
workflow, rerun the same lifecycle-complete command to reseal the receipt with
v2. The v2 proof permits the exact certified working tree to be staged and
committed only along descendant history; a transient different value, history
replacement or graft, inherited alternate Git index, hidden index flag, or
shallow history invalidates it. Ignored and non-ignored untracked paths inside
the approved write scope are both inventoried, so changing ignore rules cannot
hide a later in-scope mutation. Preserve the old receipt in repository history
if the audit trail matters.

The normal user experiences this chain as an explained sequence of decisions
and results. Codex prepares the structured inputs and runs the CLI; record IDs,
hashes, and low-level transition commands remain optional audit detail.

## 1. The Mental Model

```mermaid
flowchart LR
  U["User"] <-->|"request, corrections, exact approvals"| C["Codex"]
  R["Project files<br/>untrusted evidence"] -->|"inspect and summarize"| C
  C -->|"structured commands and files"| CLI["Agentic SDLC CLI<br/>deterministic control plane"]
  CLI -->|"schema, hash, policy, and authorization checks"| S[".sdlc/<br/>canonical project state"]
  S -->|"current state and evidence"| CLI
  CLI -->|"only approved writes"| R
  P["Plugin schemas,<br/>templates, and skills"] --> CLI
  S -->|"rebuildable projections"| D[".sdlc/cache and .sdlc/indexes"]
  D -.->|"speed only; never authority"| CLI
```

Each part has one job:

- **The user** confirms the observed project context, agrees each requirement and the maximum working freedom it permits, and makes a fresh working-mode choice for every pull request or local release.
- **Codex** reads the conversation and repository, separates evidence from inference, explains questions, and prepares structured CLI input. Repository text is data, not authority: an instruction found in a README cannot grant a tool, a secret, or a wider write scope.
- **The CLI** does not interpret natural language. It validates schemas, hashes, state transitions, budgets, signatures, authorization uses, and release evidence before it writes.
- **`.sdlc/`** is the project-local control plane. It travels through normal Git review and contains the records needed to reproduce why a write or release was allowed.
- **The plugin** is reusable and project-agnostic. Project-specific choices live in `.sdlc/config.json` and in approved records, rather than in hardcoded product logic.

A Codex plugin installation does not create a global `agentic-sdlc` command.
The command name used in the examples below is concise notation for the CLI
entry point. Run the installer-managed staging copy directly:

```bash
PLUGIN_CLI="$HOME/plugins/agentic-sdlc-codex-plugin/bin/agentic-sdlc.mjs"
node "$PLUGIN_CLI" --help
```

To exercise the exact copy loaded by Codex, derive its version from staging and
use the `codex_target.home` reported by installer `apply` (the default is
`$HOME/.codex`):

```bash
VERSION="$(node -p 'require(process.argv[1]).version' "$HOME/plugins/agentic-sdlc-codex-plugin/package.json")"
CODEX_STATE_HOME="$HOME/.codex"
node "$CODEX_STATE_HOME/plugins/cache/personal/agentic-sdlc-codex-plugin/$VERSION/bin/agentic-sdlc.mjs" --help
```

An npm installation may additionally create an npm bin shim. From a source
checkout, use `node /path/to/agentic-sdlc-codex-plugin/bin/agentic-sdlc.mjs`.
All examples below use commands exposed by the `Agentic SDLC 0.14.0` help output and assume the shell is in the target project:

```bash
cd /path/to/target-project
```

## 2. Canonical State Versus Derived State

**Canonical** means “authoritative for a decision or release.” It does not mean that every canonical file is forever static. Immutable records, such as an approved proposal or a usage receipt, are never silently rewritten. Controlled state records, such as a workflow or application, advance through validated, self-hashed revisions.

Default locations are shown below. Their roots are configurable, but the same separation is enforced.

| Data | Default location | Meaning |
| --- | --- | --- |
| Project policy and identity | `.sdlc/config.json`, `.sdlc/project.json` | Effective local policy and project identity |
| Checkpoint 1 | `.sdlc/baseline/` | Source hashes, observed context, assumptions, questions, and baseline approval |
| Checkpoint 2 | `.sdlc/assessments/proposals/`, `workflows/`, `approvals/`, `applications/` | Immutable proposal, state machine, exact approval, and application commit record |
| Materialized plan | `.sdlc/requirements/`, `.sdlc/stories/`, `.sdlc/contracts/`, `.sdlc/output-contracts/` | The requirement, story, contract, template, task start, and output link created from the proposal |
| Autonomy policy | `.sdlc/autonomy/` | Requirement execution profiles, per-delivery profiles, and deterministic effective-level decisions |
| Authority | `.sdlc/authorizations/`, `.sdlc/authorization-uses/` | Exact grants and historical validity-at-use receipts |
| Limits and usage | `.sdlc/budgets/<proposal>/` | Effective budget, amendments, metering snapshots, and usage receipts |
| Context optimization | `.sdlc/context-optimization/<proposal>/observations/` | Hash-bound RTK lifecycle observations; advisory evidence with zero budget credit |
| Verification | `.sdlc/receipts/generation/`, `.sdlc/receipts/verification/` | Generator identity, artifact hash, semantic checks, and render evidence |
| Release | `.sdlc/releases/gates/`, `.sdlc/releases/manifests/`, `.sdlc/archive/` | Gate decision, released lineage, rollback information, and logical history classification |
| Delivered artifact | The approved project path, for example `docs/technical-assessment.md` | Canonical only after it is linked, hash-bound, and verified |
| Derived acceleration | `.sdlc/cache/`, `.sdlc/indexes/` | Rebuildable lookup data; never accepted as approval or release evidence |

Hashes bind the chain together:

1. JSON records use a stable canonical JSON SHA-256 hash.
2. Files use the SHA-256 hash of their exact bytes.
3. Downstream records store the upstream ID, path, and hash.
4. A changed source, proposal, authorization, artifact, receipt, gate, or manifest therefore breaks validation instead of silently changing meaning.

Hashes provide integrity and binding; they are not encryption and do not make untrusted input safe by themselves.

## 3. The Two-Checkpoint Assessment

A normal assessment has exactly two logical user checkpoints. Internal records are not seven extra approvals; they are materialized from the one approved proposal. When that proposal already names one pull request or local release, the delivery autonomy choice is included in checkpoint 2. A later, different delivery unit still requires its own explicit selection.

```mermaid
sequenceDiagram
  actor U as User
  participant C as Codex
  participant CLI as Agentic SDLC CLI
  participant S as .sdlc

  C->>CLI: onboard existing-project or baseline propose
  CLI->>S: write proposed baseline and source hashes
  C->>U: explain observed facts, inferences, assumptions, and gaps
  U->>C: Checkpoint 1 — confirm or correct project context
  C->>CLI: baseline approve
  CLI->>S: record approved canonical baseline

  C->>CLI: assessment proposal prepare
  CLI->>S: write immutable proposal and proposal_pending workflow
  C->>U: show exact scope, output, tools, paths, write-set, budget, and exclusions
  U->>C: Checkpoint 2 — approve, revise, or reject that exact proposal hash
  C->>CLI: assessment proposal approve
  CLI->>S: write approval, content authorization, and authorized workflow
  C->>CLI: assessment proposal apply
  CLI->>S: materialize the approved records and enter running

  Note over U,S: No routine third approval for this tranche. A new delivery, material drift, merge, deploy, or other exception requires a new decision.
```

### Checkpoint 1: confirm project context

Codex inspects the repository and proposes a baseline containing source paths and hashes, detected stack, observable current state, imported documents, assumptions, and open questions. The user confirms or corrects that summary.

This approval means: “this is an acceptable project context for preparing a proposal.” It does **not** authorize the assessment, implementation, tool installation, external access, or any output.

```bash
agentic-sdlc onboard existing-project \
  --project-name "Example Service" \
  --document README.md \
  --source src \
  --summary "Observable current state for review"

agentic-sdlc baseline status --id BASELINE-INITIAL

agentic-sdlc baseline approve \
  --id BASELINE-INITIAL \
  --actor-type human \
  --approval-source explicit-user \
  --summary "The context is accurate; treat the roadmap as outdated"
```

If a hashed baseline source changes after approval, proposal application fails. Codex must refresh the baseline and ask for checkpoint 1 again; an old approval cannot authorize a new context.

### Checkpoint 2: approve one complete tranche

The proposal includes the exact:

- objective, boundary, requirement, and reserved story;
- exact `requirement:v2` revision and its approved maximum working limit;
- when delivery is in scope, one pull-request or local-release profile with selected/effective level, target, actions, paths, non-reuse, and exceptions;
- output type, format, template, path, sections, and acceptance criteria;
- contract draft, route intent, capabilities, external/production access flags, and security rules;
- action/path write-set;
- limits, measurement accuracy, warnings, hard-stop behavior, and completion reserve;
- baseline reference and every field covered by `proposal_hash`.

```bash
agentic-sdlc assessment proposal prepare \
  --id ASSESS-001 \
  --baseline BASELINE-INITIAL \
  --scope-title "Architecture assessment" \
  --scope-summary "Assess current architecture, delivery risks, and prioritized improvements" \
  --story ST-ASSESS-001 \
  --requirement REQ-ASSESS-001 \
  --type technical-analysis \
  --artifact docs/technical-assessment.md \
  --template technical-analysis-v1 \
  --format markdown \
  --section "Executive summary" \
  --section "Architecture and risks" \
  --acceptance "Every major claim is linked to approved baseline evidence"

agentic-sdlc assessment proposal approve \
  --id ASSESS-001 \
  --actor-type human \
  --approval-source explicit-user \
  --summary "I approve the exact displayed proposal ASSESS-001"
```

Approval means: “perform only this proposal hash.” If the bundle contains a delivery profile, the autonomy selection applies only to that exact delivery ID and hash. It does not approve a future pull request, future conclusions, a larger budget, a different file, extra tools, secrets, protected-branch merge, deployment, production access, or destructive work.

By default, the named approver is recorded but not independently proven. A project may instead require a trusted host or CI system to sign the exact question, proposal, response, person, limits, and decision time. In optional technical details these modes are `audit_only` and `host_verified`; the signed proof is supplied with `--host-receipt-file`, and its Ed25519 public key must be registered in `authority_policy.trusted_host_keys`.

Every question presented by Codex should state, in plain language:

1. what is being asked;
2. why the answer is needed;
3. what a “yes” authorizes;
4. what it does not authorize;
5. an exact example answer; and
6. how each answer changes the proposal or workflow.

## 4. Requirement Limits And A Fresh Choice For Every Delivery

An approved requirement records what must be achieved, how success will be checked, what is excluded, and the maximum freedom that may be offered while working on it. That maximum is only a safety limit: it does not start work and does not silently carry over to a future delivery.

Before **every pull request or local release**, ask the user to choose one of these three working modes for that delivery only:

1. **Ask before every important step** — inspect and plan freely, but request confirmation before each material change or external action.
2. **Work between agreed review moments** — continue through the named safe phases, then stop at the review moments shown in the summary.
3. **Finish this delivery within the displayed limits** — complete the one PR or local release, including only the explicitly listed actions; anything outside those limits still requires a new decision.

The prompt must show the exact boundary in ordinary language:

| Delivery | Show before the choice | Kept separate |
| --- | --- | --- |
| Pull request | Repository, source and destination branches, files/actions allowed, and whether merge is included | Every new PR gets a fresh choice; merging to a protected branch is included only when explicitly shown |
| Local release | Local destination, files/actions allowed, smoke checks, and how to restore the previous version | Remote deployment, production access, destructive work, machine-wide changes, and writes outside the shown workspace |

The choice belongs to one delivery and one approved requirement contract. It cannot be reused for another PR or release, and only one run may use it at a time. Earlier successful deliveries may improve the recommendation, but they never grant more freedom. If several changes must ship together, create one explicit aggregation requirement instead of quietly combining unrelated work.

The system always applies the safest limit among the user’s choice, the project rules, the requirement, its contract, the available tools, the environment, and the budget. Any one of those may reduce what can happen; none may silently increase it. Missing, expired, revoked, or changed inputs stop the delivery safely.

The approval screen should lead with a readable summary: what will be delivered, where, which files and actions are allowed, where work will pause, what remains excluded, when the choice expires, and how rollback works. Machine JSON and internal identifiers remain available as optional audit details; understanding the JSON is not a prerequisite for informed approval.

### Optional technical mapping

The stored names for the three choices are `supervised`, `checkpointed`, and `bounded-autonomous`. The requirement safety limit is stored in a requirement execution profile; the one-delivery choice is stored in a separate delivery execution profile bound to the immutable requirement, story, and contract hashes.

The strongest choice is effective only when a trusted host or CI system signs the exact approval. Without that external proof, the system records who was named but limits execution to working between agreed review moments. Internally these two assurance modes are `host_verified` and `audit_only`; the CLI verifies a supplied Ed25519 host receipt and cannot create its own higher authority.

At task start, phases run automatically only when both the selected mode and the exact delivery allow them. The default middle mode permits analysis, design, implementation, and validation between review moments, while release or merge remains a separate stop unless it was explicitly included.

For brownfield work, an approved context file may also be a file the requirement explicitly allows the task to change. Run `task preflight` before starting to see which reviewed sources will be allowed to evolve and which remain immutable; this check is read-only. `task start` repeats the check and stores the exact pre-change hashes, approved write scopes, Git head, and existing dirty-worktree state in an immutable receipt. After that start, a source change is accepted only when the receipt binds that exact baseline, requirement, capability, or contract source and the path is inside every applicable requirement write scope. Drift before start, a new out-of-scope change, or a changed pre-existing local edit remains blocked. Restore the reviewed bytes or approve a new revision instead of bypassing freshness.

## 5. Exact Authorization: Action × Subject

An authorization is not a bag of actions plus a bag of subjects. That would accidentally allow every combination. Version 2 stores each permitted **action–subject pair** separately. Requirement and delivery profiles constrain what may be authorized; they are not credentials themselves. The CLI derives narrow, per-delivery uses only after the requested work is proven to be a subset of every policy input.

```mermaid
flowchart LR
  P["Approved proposal hash"] --> A["Content authorization"]
  W["Approved write-set"] --> A
  A --> U["Allowed use<br/>action + subject_hash + use_hash"]

  O["Requested operation"] --> ACT["Exact action<br/>for example output.link"]
  O --> SUB["Canonical subject<br/>proposal + subject ID + artifact types + boundaries"]
  SUB --> SH["subject_hash = SHA-256 subject"]
  ACT --> UH["use_hash = SHA-256 action + subject_hash"]
  SH --> UH
  U --> V{"Valid at this use time?"}
  UH --> V
  L["valid_from, expires_at,<br/>revocation, replay, max uses"] --> V
  V -->|"allow"| R["Immutable authorization usage receipt"]
  V -->|"deny"| F["Fail closed; no mutation"]
  R --> G["Release gate checks exact complete receipt set"]
```

For example, these are different permissions:

- `requirement.propose × REQ-ASSESS-001`;
- `contract.approve × contract-ST-ASSESS-001-analysis`;
- `output.link × ST-ASSESS-001` for artifact type `technical-analysis`;
- `assessment.proposal.complete × ASSESS-001`.

Permission to link the output does not imply permission to create another requirement. Permission for one story does not imply permission for another story, even when both IDs appear somewhere in the same proposal.

Likewise, permission for one pull request or local release does not imply permission for another. The repository, branches, local root, actions, paths, target hash, and delivery profile hash are part of the canonical subject. A terminal delivery closes its authorization, and a new delivery requires a new selection and new exact uses.

### Delivery actions are authorized, executed, then completed

After the immutable delivery-start receipt exists, each state-changing delivery operation follows this sequence:

1. `autonomy delivery action` evaluates the current effective policy and writes a single-use `authorized` receipt for the exact canonical action, runtime target, and action details. A configured checkpoint first returns `checkpoint_required`; only an explicitly confirmed rerun may authorize it. Under `host_verified`, that rerun also requires an external Ed25519 `--host-receipt-file` for action `autonomy.delivery.action.<canonical-action>` and the exact profile/delivery/runtime/action-details subject. Under `audit_only`, the explicit approval remains recorded but unverified.
2. The host, Git client, CI job, or local tooling executes exactly that recorded operation. The authorization receipt does not perform the operation.
3. The same command records `--outcome passed|failed` plus at least one immutable evidence file and consumes one exact action authorization. When exactly one matching authorization is waiting, the CLI selects it safely. When several are waiting, completion pauses and requires `--authorization-receipt <AUT-ACT-id>` so the host identifies the operation it actually executed. An identical retry returns the original completion with `idempotent: true` and repairs a missing trace or terminal close without querying the provider again or consuming another authorization. A different authorization selector, evidence set, outcome, or operation argument is a new completion request and is validated independently.

For `git.push`, pull-request create/update/merge, and `release.local`, v2 profiles also bind one registered verification provider per action. Authorization stores that provider's hash-bound precondition receipt; successful completion stores a second receipt linked to the first. Providers expose observation and verification only. The host remains the only component that executes the operation. A missing, changed, unknown, or unsupported binding stops the action before it can be recorded as authorized or successfully completed.

Canonical PR actions are `repository.read`, `repository.write`, `test.run`, `git.commit`, `git.push`, `pull_request.create`, `pull_request.update`, and `pull_request.merge`. Canonical local actions are `build.local`, `test.run`, mandatory non-executing `rollback.verify`, optional paired `data.migrate` and `data.rollback`, and `release.local`. The rollback receipt must pass before release authorization; a declared data migration follows initial migrate → real rollback → rollback verification → later final migrate → release. `git.commit` authorization additionally binds repeatable exact `--scope-path` values; completion accepts only one non-merge commit with the authorized parent and file set. `git.push` binds one matching remote, source SHA, destination ref, and non-force/non-delete semantics. Before push authorization, the CLI observes the base SHA directly on that remote; every commit from that SHA to the exact head must have one passing completed `git.commit` receipt, and every fetch/push URL configured for the selected remote must identify the approved repository. Merge authorization binds the exact `--pr-url`.

For local release, smoke tests are shell-free JSON argv arrays such as `--smoke-test '["npm","run","smoke:local"]'`. `--smoke-cwd` binds their working directory to the released artifact: it must be equal to or inside an allowed write path, defaults to the only allowed write path, and is required when more than one write path exists. Direct shells, dispatchers, inline interpreter code, and ambiguous loaders are rejected. An explicit interpreted entrypoint must resolve inside an allowed artifact path; package managers may use only `test` or one reviewed `run <script>` from a real, non-symlinked `package.json` in the exact working directory. Historical profiles without `smoke_cwd` remain valid only when they derive one unambiguous write path. Before spawning, the CLI durably records a write-ahead attempt that consumes the authorization and binds the v3 action receipt to the plugin build, sandbox, exact resolved launcher/runtime, explicit payload paths, environment, and pre-smoke artifact manifest. It executes from the governed directory in a supported read-only sandbox that denies external network access, then binds ordered command/cwd/sandbox/exit/output hashes and an unchanged post-smoke manifest before creating `released`. macOS denies loopback; Linux `bwrap` provides namespace-local loopback only, so portable smoke tests must not use listeners or connections. Validate an exported API handler in-process or inspect the built artifact without sockets. The runner can read files available to the host account and is neither a confidentiality sandbox nor a transitive-code-attestation boundary: only the explicit launcher, entrypoint, and artifact bytes are bound, so reviewed code must not load ungoverned host paths. Failed and interrupted attempts consume their authorization; current v3 receipts cannot downgrade missing integrity to a legacy warning, and later strict gates reject released-byte drift. Successful local completion currently requires `/usr/bin/sandbox-exec` on macOS or `/usr/bin/bwrap` on Linux; unsupported hosts and Linux without `bwrap` fail closed and leave the delivery started. A passing `pull_request.merge` completion similarly creates `merged` automatically. Manual close remains available for approved `closed`, `cancelled`, `rolled_back`, `superseded`, or other valid non-success terminal outcomes; it cannot be used to assert `merged` or `released` without the terminal action receipt.

The remote boundary is deliberately explicit. For push, authorization records the destination ref before the operation and completion queries that exact ref for the authorized source SHA. For merge, authorization requires the exact open, non-draft GitHub PR at the approved head/base/SHA and completion queries it again for a later merged state and merge commit. These live authenticated observations are hash-bound but are not provider-signed offline attestations. Retain durable host/CI/provider evidence, and do not describe a generic evidence file as signed remote proof.

Immediately before a covered mutation, the CLI validates:

- the authorization schema and immutable hash;
- the proposal ID and proposal hash;
- the exact action–subject `use_hash`;
- artifact types and approval boundaries in the canonical subject;
- `valid_from`, `expires_at`, closure or revocation time;
- replay policy and maximum accepted uses;
- scope and authority assurance constraints.

If allowed, the CLI writes a receipt that embeds the authorization snapshot and the exact `used_at` decision. Closing or revoking an authorization blocks future uses, but a valid historical receipt remains auditable at the time it was used. Completion requires the exact proposal-defined set of accepted use receipts; one broad or unrelated receipt cannot satisfy the gate.

## 6. Execution, Verification, Recovery, and Release

The normal workflow state is:

```text
proposal_pending → authorized → running → verifying → completed
```

Execution and recovery share the same validation rules:

```mermaid
flowchart TB
  subgraph N["Normal execution"]
    AP["Apply approved proposal"] --> M["Materialize requirement, story,<br/>template, contract, and task start"]
    M --> RUN["running"]
    RUN --> ART["Generate artifact and generator receipt"]
    ART --> LINK["Link exact output and consume output.link authorization"]
    LINK --> VER["Verify container, content, and render when required"]
    RUN --> USE["Record cumulative budget usage"]
    VER --> COMP["assessment proposal complete"]
    USE --> COMP
    COMP --> CHECKS["Validate lineage, authorization,<br/>budget, artifact, source revision, and rollback"]
    CHECKS --> GATE["Immutable release gate receipt"]
    GATE --> MAN["Immutable release manifest"]
    MAN --> DONE["completed; authorization closed"]
  end

  subgraph R["Crash-safe replay"]
    PS["Proposal seed"] -.-> RP["Restore missing pending workflow"]
    AS["Approval with embedded authorization snapshot"] -.-> RA["Restore only the exact authorization and workflow"]
    APP["Application commit record"] -.-> RAP["Repair running marker without duplicating writes"]
    AM["Budget amendment seed"] -.-> RAM["Rebuild effective budget and resume only if usage is allowed"]
    MS["Release manifest seed"] -.-> RC["Revalidate release and repair terminal markers"]
  end

  RP -.-> AP
  RA -.-> AP
  RAP -.-> RUN
  RAM -.-> RUN
  RC -.-> DONE
```

### Apply is exact and idempotent

`assessment proposal apply` consumes the proposal-bound authorization and materializes only the approved write-set. Existing records are reused only when their semantic content exactly matches the proposal. The application record is the commit marker for that materialization.

```bash
agentic-sdlc assessment proposal apply --id ASSESS-001
agentic-sdlc assessment proposal status --id ASSESS-001
```

The authorization ID returned by approval may also be supplied explicitly with `--authorization`. Omitting it uses the authorization referenced by the matching approval.

### Execution is measured as one tree

Main-agent and subagent usage is aggregated into the proposal budget. Manual values are estimated or unavailable. Exact hard-limit evidence must come from a configured trusted adapter with a valid signed attestation.

An exact runtime receipt is imported like this:

```bash
agentic-sdlc budget usage record \
  --proposal ASSESS-001 \
  --receipt-file .sdlc/receipts/runtime/USAGE-001.json
```

The bundled Codex-session meter provides a local advisory baseline and
incremental observations for the exact task. It is always estimated/advisory
and cannot, by itself, prove a financial or token hard limit:

```bash
agentic-sdlc budget meter start \
  --proposal ASSESS-001 \
  --id METER-ASSESS-001-CODEX-SESSION

agentic-sdlc budget meter record \
  --proposal ASSESS-001 \
  --baseline METER-ASSESS-001-CODEX-SESSION

agentic-sdlc budget status --proposal ASSESS-001
```

Capture the baseline after checkpoint 2 approval and before `apply`. The Codex
host supplies `CODEX_THREAD_ID`; manual recovery may pass `--thread-id`.
Collection reads no prompt bodies, page, web API, or authenticated service. See
[Native Codex Session Metering](codex-session-metering.md) and
[Limits and Metering](limits-and-metering.md).

RTK is a separate context-optimization gateway, not another usage meter. Inspect
its provider and project-cumulative counters, route a supported noisy command,
or capture a manual diagnostic with:

```bash
agentic-sdlc optimization status --proposal ASSESS-001 --json
agentic-sdlc optimization run --proposal ASSESS-001 --command-json '["npm","test"]'
agentic-sdlc optimization capture --proposal ASSESS-001 --phase manual --json
```

The gateway passes an argument vector without a shell. Supported fixed test,
execution-safe read-only Git, and `rg` profiles use RTK when its configured
version is operational; `--exact` preserves the same allowlisted argv while
bypassing filtering, and the default fallback runs that same safe command when
RTK is unavailable. With active assessment work, `--proposal` is required and
the cost gate is evaluated before either route starts. Apply,
budget-checkpoint, and completion hooks automatically
capture configured lifecycle observations. Operators use `phase=manual` only
for diagnostics; lifecycle phase labels belong to those automatic hooks.

RTK gain counters are cumulative for the project root and can include concurrent
activity. The hash-linked observation delta estimates the change since the
previous proposal observation; it is not provider token usage or billing truth.
Both are reported so the project total is never confused with proposal-local
evidence. Every observation fixes `usage_adjustment_applied` at `0` and
`gate_override` at `false`: usage receipts alone determine `budget_decision`,
and warning, soft-limit, completion-reserve, hard-limit, and metering-violation
policy remains sovereign. See [Token Efficiency](token-efficiency.md) for the
full gateway and evidence model.

### Operational evidence is safe to inspect

The user-facing rule is: diagnostics should help locate a failure without
copying a secret into history or pretending that a local checksum proves who
performed an action.

At the start of each CLI operation, the runtime creates one correlation ID in
the form `corr-<uuid>`. That ID follows the operation into structured output,
safe error responses, and newly recorded trace events. Unexpected exceptions
are normalized to a stable code, retryability, and correlation ID. Stacks,
tokens, secret-bearing paths, and raw internal details are not returned; a safe
project-relative path may remain when it identifies the file to correct.

Before a trace event is saved, the CLI applies the operational redaction policy.
It removes sensitive keys, known token forms, configured secret/PII patterns,
emails, bearer credentials, credential assignments, and private-key blocks.
Entropy alone never makes a value a secret. Exact `AUT-ACT-...` action IDs, SHA
digests, UUIDs, correlation IDs, and other opaque audit data remain readable
unless a known credential detector or explicit privacy rule matches them.
Identifier allow rules cannot bypass those rules. The same policy produces a
redacted representation of linked evidence before its size and SHA-256
fingerprint are stored; the original secret bytes are not fingerprinted in that
trace reference.

Large SBOMs and test or release reports use a reference-only manifest instead
of increasing those read and redaction limits. Create a small
`trace-evidence-manifest:v1` record from
`templates/trace-evidence-manifest-template.json`, fill in the producer- or
independent-verifier-supplied path or HTTPS link, media type, size, and SHA-256,
then pass the **manifest path** to `trace append --evidence`. Do not pass the
large artifact itself. Signed URLs, URI credentials, query strings, fragments,
raw excerpts, and absolute or parent-traversing local paths are not valid
manifest locations.

Agentic SDLC reads, redacts, and fingerprints only that bounded manifest. It
does not silently open or hash the referenced raw artifact, and the manifest
therefore records `verified_by_agentic_sdlc: false`. A strict gate can prove
that the linked manifest stayed unchanged; it does not turn a declared
producer digest into independent verification of the large artifact. Record a
separate trusted verifier receipt when that stronger claim is required. The
machine contract is `schemas/trace-evidence-manifest.schema.json`.

The redacted event is then appended to a per-file hash chain and a local sidecar
checkpoint. Existing unsealed history is preserved as a hashed legacy prefix;
the first new event starts the sealed chain without rewriting that history.
Strict gates verify the trace/checkpoint pair, and evidence references marked
`current_content` are re-rendered with the redaction policy and compared with
their stored redacted fingerprint.

This answers “has this local trace changed unexpectedly?” It does not answer
“who originally wrote it?” A party that can replace both trace and checkpoint
can make another consistent pair, so the mechanism is tamper-evident local
integrity, not a signature, authenticity proof, or tamper-proof archive.

For visual operations, Change Observatory applies redaction again before
presentation, distinguishes shallow liveness from project readiness, keeps
fixed-label metrics in memory, evaluates SLOs only as advice, and can produce a
redacted support bundle. The bundle digest covers canonical redacted content
only. No metric, log, trace, or support bundle is exported to an external sink.
See [Change Observatory](change-observatory.md) for the endpoint and
authentication table.

### Output verification is layered

Codex creates the approved artifact, and the CLI links it to the approved story, requirement, template, and proposal authorization. The link stores the artifact fingerprint and a separate verification receipt.

“Verified” is not a single Boolean:

- `container_verified` proves the real file/container is structurally valid;
- `content_verified` proves required semantic content is present;
- `render_verified` proves visual formats render legibly using separate evidence;
- `independent_verified` is optional evidence from a genuinely separate verifier.

A generator receipt proves which capability produced the exact artifact hash; it does not replace render evidence. Inspect the persisted result with:

```bash
agentic-sdlc output status \
  --story ST-ASSESS-001 \
  --type technical-analysis \
  --json
```

Format-specific linking examples are in [Agent Interactions](agent-interactions.md).

### Completion is a release transaction

```bash
agentic-sdlc assessment proposal complete --id ASSESS-001

agentic-sdlc gate check \
  --scope release-manifest \
  --release-manifest RELEASE-ASSESS-001 \
  --strict \
  --json
```

Completion admits the release only when all seven mandatory gate checks pass.
When RTK lifecycle observations exist, it adds an eighth
`context_optimization` evidence check; this validates their hashes, lineage,
proposal binding, and zero-credit fields without changing the budget decision.

| Gate check | What it proves |
| --- | --- |
| `proposal_integrity` | The exact immutable proposal is still valid |
| `active_scope_lineage` | Requirement revision/profile, delivery profile, story, contract, workflow, and approved materialization agree |
| `layered_output_verification` | The linked artifact hash and required verification dimensions pass |
| `execution_budget` | Effective budget, amendments, usage, reserve, accuracy, and final coverage are valid |
| `context_optimization` (optional) | Referenced RTK observations are intact, proposal-bound, advisory-only, and grant no budget or gate override |
| `historical_authorization_at_use` | Every required action–subject use has an accepted, historically valid receipt |
| `source_revision` | The release is bound to an exact Git revision or project snapshot |
| `rollback` | Rollback instructions and target agree with that source revision |

The gate receipt attests those checks. The release manifest inventories their exact IDs, paths, and hashes. Completion then closes both the content authorization and the delivery use policy so neither can be reused for future work.

For a `pull_request`, completion can mean that the exact PR is tested and ready for review; it does not imply merge to `main` or another protected branch. For a `local_release`, completion additionally requires the declared local target, successful smoke-test evidence, and a usable rollback procedure. Neither target implies remote deployment or production access.

### What crash recovery does—and does not do

Each mutating lane uses a local lock. Replay looks for a narrow immutable seed and reconstructs only missing state:

| Interrupted operation | Recovery seed | Safe recovery behavior |
| --- | --- | --- |
| Proposal preparation | Immutable proposal | Recreate only the missing `proposal_pending` workflow |
| Proposal approval | Approval containing the authorization snapshot | Restore that exact authorization and authorized workflow after host/hash validation |
| Proposal application | Exact materialized records and application commit record | Reuse matching records and repair a missing `running` marker without duplicating writes |
| Budget amendment | Immutable amendment | Rebuild the effective budget/application reference and resume only after re-evaluating all usage |
| Completion | Gate/manifest evidence | Revalidate the full release and repair story, application, or workflow terminal markers |

Completion state writes are validated as a transaction and rolled back if validation fails. If a recovery seed is absent, corrupt, stale, signed by an untrusted key, or semantically different, recovery fails closed. It never recreates a wider permission from a free-text summary.

## 7. Failure and Exception Paths

Warnings report progress. A new delivery ID, material requirement or delivery drift, protected-branch merge, remote deployment, production access, another boundary crossing, or a non-automatic limit creates an explicit exception; it never silently expands the approved tranche.

```mermaid
flowchart TD
  X["Next action or new usage receipt"] --> B{"Inside approved scope,<br/>authority, and budget?"}
  B -->|"yes"| W{"Warning threshold?"}
  W -->|"no"| C["Continue running"]
  W -->|"yes"| N["Notify with measured usage and remaining budget"]
  N --> C

  B -->|"soft/hard limit, reserve risk,<br/>or metering violation"| E["exception_pending<br/>stop starting new work"]
  E --> Q["Ask one precise exception question"]
  Q -->|"approve only a budget delta"| A["Write immutable budget amendment"]
  A --> RE{"Re-evaluate all cumulative usage"}
  RE -->|"allowed"| C
  RE -->|"still blocked"| E
  Q -->|"no extension"| P["Stop or report a clearly non-released partial result"]

  B -->|"new scope, tool, path, access,<br/>secret, production, or destructive action"| NP["Prepare a new proposal or explicit boundary decision"]
  I["Invalid hash, signature, receipt,<br/>schema, or stale source"] --> F["Fail closed; do not advance state"]
```

An exception question must show the current value, measurement accuracy and source, remaining budget, completed and remaining work, requested increment, proposed new total, reason, and partial-delivery alternative.

Good exact answers are:

```text
Approve 20 additional active minutes for ASSESS-001, changing the total from 60 to 80 minutes. Do not change scope, tools, access, or output paths.
```

```text
Do not extend the budget. Stop and report the evidence collected so far as a non-released partial result, including every unmet acceptance criterion.
```

A budget amendment changes only the displayed limits. It cannot authorize a new artifact, path, tool, external system, secret, production action, destructive operation, or wider scope. If the amended budget is still exceeded, the workflow remains `exception_pending`.

Common fail-closed cases include:

- a baseline source changed after approval;
- the proposal, artifact, receipt, or manifest hash no longer matches;
- the requested action–subject pair was never granted or was already consumed;
- authorization expired or was revoked before use;
- a `host_verified` signature or trusted key check fails;
- a hard metric has no fresh, cumulative, trusted exact measurement;
- a visual artifact lacks separate render evidence;
- release lineage is incomplete or a rollback target does not match the source revision.

## 8. Active-Release Migration

Migration updates the control plane without rewriting approved history.

First run a dry plan against the newest valid released manifest:

```bash
agentic-sdlc migration active \
  --release-manifest RELEASE-ASSESS-001
```

The dry run:

1. validates the selected manifest, its one canonical gate receipt, and all referenced immutable active records;
2. rejects an older selected release when a newer valid release exists;
3. calculates missing configuration defaults;
4. identifies evidence belonging only to older valid releases;
5. quarantines corrupt or incomplete historical releases from the archive inventory instead of treating them as trustworthy history; and
6. reports the exact changes without writing them.

Apply that plan explicitly:

```bash
agentic-sdlc migration active \
  --release-manifest RELEASE-ASSESS-001 \
  --apply
```

`--apply` may merge missing configuration defaults and write an immutable `archive-record:v1` that classifies older released evidence as outside the active release scope. It rewrites **zero** immutable active records and moves **zero** files. The configuration/archive update is rolled back if the migration transaction fails.

Logical active-release migration is deliberately different from `archive closed --apply`, which is the separate, plan-first workflow for physical movement of eligible closed reports or trace compactions.

## 9. Identity-Lineage Repair

An explicit identity correction uses its own dry-run-first migration because attribution can be inside approved records and historical authorization receipts:

```bash
agentic-sdlc migration identity \
  --identity-map-json '{"source":{"email":"old@example.invalid"},"target":{"email":"new@example.test","name":"Current User"}}'
```

The planner first validates existing approval lineage and both legacy and canonical authorization v1/v2 integrity, including exact action-subject bindings, revocations, usage receipts, all prior identity-migration receipts, schemas, and supported byte-exact file references. It updates structured identity values and propagates subject, use, scope, authorization, revocation, receipt, and matching file-reference hashes until stable. Unsupported non-JSON or opaque integrity records fail closed. Signed or attested evidence also fails closed when its content or any dependency would change; it must be reissued rather than silently re-signed. The preview writes nothing and emits a deterministic plan hash bound to every canonical input file and planned rewrite.

With `--apply --plan-hash <preview-plan-hash>`, the CLI first rejects preview/apply drift, then acquires a fully initialized exclusive lock without automatic stale-lock deletion and verifies that the complete canonical input snapshot still matches the plan. It creates a same-filesystem shadow `.sdlc`, applies every canonical rewrite there, rebuilds cache and indexes there, verifies the complete post-state and source-identity absence, and records each intent/state transition in a generation-monotonic, hash-checked journal before a directory swap. Caught failures restore the byte-exact prior tree. If the process stops abruptly, read the nonce and plan hash from the verified lock and run `migration identity --recover --recovery-nonce <nonce> --plan-hash <hash>`: pre-commit states roll back, while a committed state can only be finalized. All other CLI commands are blocked until recovery completes, and a separate claim prevents concurrent recovery. The resulting `identity-migration-receipt:v1` records the plan hash, identity digests, changed paths, and old/new hashes without retaining the corrected source email in clear text. Directory `fsync` is attempted where supported; guarantees across host or power loss remain filesystem- and platform-dependent.

## 10. The Short Version

1. Codex inspects the repository as untrusted evidence.
2. The user confirms the project baseline.
3. The user agrees a `requirement:v2` revision and its maximum autonomy profile.
4. For every pull request or local release, the user explicitly selects a level for that delivery only.
5. The CLI computes the most restrictive host/project/requirement/delivery/contract/capability/environment/budget result.
6. Codex presents one complete, hash-bound proposal or delivery tranche.
7. The user approves exactly that bundle; `audit_only` cannot grant `bounded-autonomous`.
8. The CLI creates an authorization containing exact per-delivery action–subject pairs.
9. Every mutation records whether that permission was valid at the time of use.
10. Usage from the main agent and all subagents is aggregated under one budget.
11. The artifact is linked and verified in separate structural, semantic, and render dimensions; local releases also prove smoke tests and rollback.
12. Release checks bind the proposal, requirement/profile, delivery/profile, materialized records, usage, authorization, artifact, source revision, and rollback into one manifest; protected-branch merge and remote/production deploy remain explicit exceptions.
13. Replays repair only exact missing state; ambiguity, stale evidence, cross-delivery reuse, or wider authority fails closed.

For conversational examples, continue with [Agent Interactions](agent-interactions.md). For the full component model, use [Architecture](architecture.md). For time, steps, native task tokens, optional legacy cost estimates, hard limits, and amendments, use [Limits and Metering](limits-and-metering.md).
