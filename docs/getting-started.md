# Getting Started

Agentic SDLC lets you ask Codex for an outcome in normal language while a deterministic CLI checks that the agreed requirement, files, tools, delivery target, limits, and evidence remain consistent.

You do not need to create record IDs, write JSON, choose CLI commands, or understand hashes before asking for work. Codex handles the conversation; the CLI handles deterministic validation and state changes.

## Choose A Starting Request

Open the target project in a new Codex task and use the request that matches your intended result.

| I want to... | Ask Codex... |
| --- | --- |
| Understand an existing project | `Contextualize this project and prepare an initial technical assessment.` |
| Agree and deliver a new requirement as a new PR | `Turn this new requirement into an agreed work brief, implement it, verify it, and open a new pull request.` |
| Continue one PR that already exists | `Continue this existing pull request, verify the requested changes, and update the PR without creating a new one.` |
| Build and verify only on this machine | `Build and verify this result only on my local machine. Do not push, open a pull request, deploy, or use production.` |
| Inspect recorded delivery history | `Open the Change Observatory and explain this project's recorded delivery lineage.` |

Add the real requirement, PR URL, desired local destination, constraints, exclusions, or success criteria after the starter. Codex should preserve values you already supplied and ask only for material gaps.

## Conversation And Control Have Different Jobs

| Part | Its job |
| --- | --- |
| Codex conversation | Understand your request, inspect evidence, distinguish fact from inference, explain the proposed work, and ask for decisions in plain language. |
| Deterministic CLI | Agentic SDLC validates structured intent, approved records, permissions, limits, hashes, state transitions, and evidence. It does not interpret your prose. |
| Project `.sdlc/` directory | Keep the project-specific decisions and evidence with the project. |

Internal names may appear under **Technical details (optional)**. They are audit information, not prerequisites for making the primary decision.

## The Delivery Journey

For implementation work, Codex follows one visible order:

1. **Preview and normalize**
   Codex restates the outcome, project, destination, evidence boundary, and missing facts. This is read-only planning. The task has not started.

2. **Agree the requirement**
   You review the desired outcome, observable success criteria, non-goals, constraints, integrations, and the most independence this requirement may permit.

3. **Decompose only when needed**
   A small bounded change can remain one story. Larger work receives a proposed breakdown and dependencies before they become part of the plan.

4. **Agree the output and work brief**
   Codex shows the concrete files, tools, tests, branches or local target, verification, protected actions, and rollback where relevant. “Work brief” is the plain-language view of the formal contract.

5. **Choose autonomy for this one delivery**
   Every new pull request, existing pull request, or local release gets a fresh choice. A choice from an earlier delivery is never reused.

6. **Start the story workflow, then start once**
   Codex first binds the exact configured phase order to the story. This must
   happen before task start and before the first completed step. Only then does
   Codex make the task-start decision. An explicit start confirmation, when
   required, completes that same start; it is not a second planning phase. A
   worker can claim the story only after this start succeeds for the current
   approved contract.

7. **Implement and test**
   Codex claims the started story, changes only the displayed paths, runs the
   agreed checks, records evidence, completes each phase, and enters the next
   phase only after the previous one is complete.

8. **Validate, then enter release**
   After validation is complete, Codex seals the intermediate strict receipt
   and moves the bound workflow into `release`.

9. **Finish and certify at the named destination**
   Only after entering `release`, Codex creates or updates the one approved PR,
   or completes the local-only release, release trace, release step, and smoke
   test. It releases the completed story claim, then runs the distinct
   lifecycle-complete gate. Merge, remote
   deployment, and production remain separate unless explicitly included and
   approved.

If a material requirement, branch, path, tool, budget, environment, or destination changes, Codex shows the changed boundary before continuing.

### Declare paths before work starts

For implementation, validation, or release, the requirement records every
project area that may receive a durable change. Source, tests, documentation,
and evidence are separate areas, so Codex should show all that apply before
asking you to approve the requirement. The stored requirement paths are
sorted, deduplicated, and Git-relative, for example `src`, `test`, `docs`, and
`evidence`. The project root, paths outside the project, and `.git` repository
metadata are never valid. Govern Git commits, pushes, and merges through their
explicit delivery actions instead of granting file-write scope over `.git`.

An empty path list is useful only for governance work that changes no product
or named output. If product work reaches task start with an empty requirement
scope, Agentic SDLC stops before preflight and explains how to create a new
requirement revision with `--write-path`. Omitting paths while revising
inherits the existing scope; supplying any path replaces the whole list.
Approval never silently repairs an older non-canonical proposal.

This requirement boundary is different from a local-release destination.
Requirement paths describe project-relative material scope. A local release
shows an explicit absolute target and absolute allowed paths inside that target,
for example `/absolute/project/.local-release` and
`/absolute/project/.local-release/app`.

## Walk Through One Complete First Project

This example follows one small result all the way through the lifecycle. It is
the same trip-policy journey summarized in the README, so a first-time user
does not need to assemble separate feature examples.

Start in a disposable repository and ask:

```text
Inspect this repository, then implement a configurable trip-policy module as a
local-only release. It must reject trips above a configurable cost limit, include
tests, and avoid network, production, and machine-global changes.
```

Use `ST-TRIP-POLICY-001` as the stable story identifier. Codex should make each
stage understandable before moving to the next:

| Stage | What Codex should show | What makes the stage ready |
| --- | --- | --- |
| Discovery | Observed project facts, inferences, relevant files, assumptions, and missing decisions | You correct or accept the displayed context; no implementation has started |
| Requirement | Configurable limit behavior, observable acceptance checks, non-goals, constraints, maximum autonomy, and Git-relative source/test/docs/evidence scope | One exact requirement revision with every needed project path is approved |
| Contract | Source/test paths, configuration boundary, commands, local destination, allowed smoke-test working directory, smoke test, rollback, allowed writes, and excluded actions | One exact implementation agreement is approved |
| Story and workflow | Story `ST-TRIP-POLICY-001` and a story-bound `software-project` v3 journey through discovery, analysis, design, implementation, validation, release, and operations | The workflow starts before task start and the first completed step; a custom phase order uses an approved exact-match definition |
| Implementation | Only the approved source, configuration, test, and documentation changes | The implementation matches the requirement and contract |
| Test and validation | The exact test command, latest outcome, evidence location, and any failed or skipped check | The latest required test and output verification pass; an older success cannot hide a newer failure |
| Release entry | The ordinary strict validation receipt and the transition into `release` | Validation is complete before release entry; no release trace or delivery close exists yet |
| Local release | Exact local destination, passing release trace, completed release step, terminal `released` status, successful smoke evidence, usable rollback, and released story claim | All release evidence occurs after entry into `release`; no active claim can race final certification; push, PR, deployment, and production remain excluded |
| Final certification | One strict lifecycle result bound to this story and its terminal delivery | Every configured phase and current canonical record passes together |

After validation is complete, Codex runs the ordinary strict check and uses its
distinct intermediate receipt to move the story-bound workflow into its
terminal `release` phase. Only then does it perform the local release, append
the passing release trace, complete the release step, and close the delivery.
After those records exist, Codex releases the completed story claim and runs:

```bash
node <plugin-root>/bin/agentic-sdlc.mjs gate check \
  --strict \
  --story ST-TRIP-POLICY-001 \
  --lifecycle-complete
```

A strict check without `--lifecycle-complete` is the intermediate readiness
receipt, not the final delivery certificate. The lifecycle command must fail
before required phases, current test evidence, the named release, and the
current workflow's terminal state are complete. On success, ask Codex to show
the final receipt, delivered path, checks run, exclusions, and residual risks
in plain language.

If status reports an old `workflow-final-freshness-proof:v1`, keep it as
historical evidence and rerun that exact lifecycle-complete command on the
reviewed terminal project. A passing rerun writes the current v2 proof. V2
accepts staging or committing the exact certified bytes on descendant history,
but rejects different transient commits, rewritten/replaced history, alternate
Git index environments, shallow history, hidden index flags, and any later
governed-path drift. Untracked files inside the approved scope remain covered
even when project, repository, or global Git ignore rules match them.

If the same requirement later needs a pull request, create a new delivery
profile and autonomy choice for that PR. Do not reuse the completed local
release authorization.

## What You Approve

Approval is attached to the content just shown, not to a vague permanent permission.

| Decision | What it authorizes | What it does not authorize |
| --- | --- | --- |
| Project context, for an assessment | Treat the displayed facts and corrected inferences as the assessment baseline | Analysis, writes, tools, budget, or execution |
| Requirement | The displayed outcome, success criteria, exclusions, constraints, and maximum working independence | A pull request, local release, implementation, or future requirement revision |
| Breakdown, only when needed | The displayed stories and dependencies | Implementation or a delivery target |
| Work brief | The displayed output, paths, tools, tests, contract, and protected actions | Another contract, wider paths, installs, secrets, production, or another delivery |
| Delivery autonomy | The selected working mode for exactly one named PR or local release | Another PR, protected-branch merge, deployment, production, or unrelated work |
| Action checkpoint | The exact paused action and target shown by Codex | Any other action or target |

The guided assessment is intentionally shorter: it has two normal checkpoints—project context, then one complete assessment proposal. Internal assessment records are applied from that approved bundle rather than becoming extra questions.

## Autonomy Is Explained Before You Choose

Before listing the choices, Codex first tells you whether the most independent option is actually available in the current installation.

1. **Guided** — Codex asks before important steps.
2. **Autonomy with checkpoints** — Codex works between agreed review moments and stops at the displayed sensitive actions.
3. **Full autonomy inside these limits** — Codex completes this one delivery without routine pauses, but only when the installation can digitally verify the approver for that exact delivery.

If the installation records the approver but cannot digitally verify that identity, Codex says **before the choice** that option 3 will be reduced to **Autonomy with checkpoints**. You can then choose with the real effective behavior visible.

Even the strongest mode never silently includes a different PR, protected-branch merge, remote deployment, production, secrets, destructive work, new external services, new paths, or extra budget.

## New Requirement And New Pull Request

Use:

```text
Turn this new requirement into an agreed work brief, implement it, verify it, and open a new pull request.
```

Add the requirement below it. Before starting, Codex shows:

- the requirement and observable success criteria;
- the repository and base branch;
- the new head branch;
- files that may change and tests that will run;
- whether commit, push, PR creation, and later PR updates are included;
- whether merge is excluded;
- the autonomy available for this PR only.

Creating the PR is different from merging it. A ready PR does not imply protected-branch merge, deployment, production access, or secret use.

## Continue An Existing Pull Request

Use:

```text
Continue this existing pull request, verify the requested changes, and update the PR without creating a new one.
```

Include the PR URL or exact repository and PR number. Codex resolves and displays the existing repository, base, head, current SHA, requested delta, allowed files, checks, and update actions. It must update that PR and must not create a second one.

A changed PR head, base, repository, or material requirement is drift. Codex pauses and shows the new boundary instead of applying an old approval to changed work.

## Local-Only Result Or Release

Use:

```text
Build and verify this result only on my local machine. Do not push, open a pull request, deploy, or use production.
```

Before starting, Codex shows:

- the exact absolute local destination and absolute allowed write paths inside it;
- build and test actions;
- a shell-free smoke test;
- how to restore the previous local result;
- the explicit exclusion of Git push, PR create/update, remote deployment, production, secrets, destructive work, and machine-global changes.

“Local” describes the destination and data boundary; it does not mean unrestricted. A missing tool installation, write outside the workspace, or machine-global change remains a separate decision.

### When the local destination does not exist yet

The destination may be absent while the delivery is being planned, approved,
or started. Before `rollback.verify`, `data.migrate`, `data.rollback`, or
`release.local`, Codex follows this governed build sequence:

1. Request `build.local` once without `--confirm-action`.
2. If, and only if, the response is `checkpoint_required`, show you the exact
   paused decision and repeat the same request with direct human or CI approval.
   If the first request is already authorized, it is not confirmed again.
3. While that exact authorization is active, let the external builder create
   only the approved destination root, approved children, and artifact. The
   Agentic SDLC CLI does not create the directory.
4. Complete the same `build.local` authorization with immutable evidence.
5. Only after that completion, continue with `rollback.verify`, any declared
   `data.migrate`/`data.rollback` cycle, and `release.local`.

Creating the destination with an untracked `mkdir` does not repair a blocked
release: the creation itself belongs to the approved build boundary.

## Local, Repository, And Production Are Separate

| Boundary | Examples | Network or wider authority |
| --- | --- | --- |
| Local execution and data | Read project files, write approved paths, run tests, store `.sdlc/` evidence, create a local release | No repository publication or deployment is implied |
| Repository publication | Fetch the approved remote state, push the approved branch, create or update the named PR | Uses the network and only the displayed repository/branches |
| Deployment or production | Deploy a service, change production, access a live tenant, use production secrets | Always a separate exact decision unless already displayed and authoritatively approved |

A pull request is repository publication; it is not a production deployment. A local release is local; it is not permission to push. Change Observatory is a local, read-only viewer and does not publish project evidence.

## When The Workflow Pauses

Start with a read-only question:

```text
Why is Agentic SDLC blocked? Explain what happened, what remains protected, and the next safe action without changing anything.
```

Operators can use:

```bash
node <plugin-root>/bin/agentic-sdlc.mjs status
node <plugin-root>/bin/agentic-sdlc.mjs status --locale it
node <plugin-root>/bin/agentic-sdlc.mjs doctor --root /path/to/project
node <plugin-root>/bin/agentic-sdlc.mjs config status --root /path/to/project
```

`status`, `doctor`, and `config status` inspect and explain; they do not approve work or widen permissions.

Common pauses are handled as follows:

| Pause | Safe next action |
| --- | --- |
| Missing requirement or destination detail | Answer the displayed question; the answer does not start work by itself |
| Work brief or source changed after approval | Review the refreshed content and approve only the new displayed version |
| Option 3 was reduced | Continue with checkpoints, or separately configure a trusted host/CI if full autonomy is genuinely needed |
| A push, merge, release, install, production, or secret boundary was reached | Decide only the exact action and target shown |
| A budget boundary was reached | Approve only the displayed extension, request a verified partial result, or stop |
| An application was interrupted | Repeat the exact same operation so idempotent recovery can repair only missing state |
| Configuration drifted | Preview the configuration migration, review the diff, and apply only the displayed plan hash |

For installation failure, use the exact `restore` command returned by the installer transaction. Do not manually delete or overwrite an uncertain destination. See [Portable Installation](portable-install.md) for install-specific recovery.

## What A Finished Result Means

A completed delivery reports:

- what requirement and delivery target were used;
- what changed;
- which tests and verification dimensions passed;
- the artifact or PR location;
- what was not done;
- remaining risks, limits, and decisions.

A passing gate proves the displayed evidence and lineage. It does not silently merge a protected branch, deploy remotely, access production, or approve future work.

For protocol-level details, continue with [How It Works](how-it-works.md). For resource controls and the technical autonomy model, see [Limits, Autonomy, and Metering](limits-and-metering.md).
