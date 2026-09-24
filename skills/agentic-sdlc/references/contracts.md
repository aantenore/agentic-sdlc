# Contract Model

A contract is the operational descriptor for an SDLC phase or story. It tells Codex and human reviewers how the step must be executed, produced, validated, and traced.

Contracts are project-bound. The templates are generic, but generated contracts must include the target project identity and contextualization metadata captured from the project KB, user input, files, and open questions.

## Required Fields

- `id`: Stable contract identifier.
- `phase`: One of `discovery`, `analysis`, `design`, `implementation`, `validation`, `release`, `operations`.
- `project`: Target project identity.
- `purpose`: Why this phase exists.
- `owner_agent`: Default agent role responsible for the phase.
- `inputs`: Required source material.
- `outputs`: Required artifacts.
- `output_contract_refs`: Story output coverage references to approved output templates and reuse mode. Each reference may add an optional `phase` that says when the output becomes due in the bound workflow. A story contract for an output-producing phase must include at least one legacy unphased reference or one reference assigned to that exact contract phase; future-only output lists are incomplete and cannot be approved.
- `validation`: Gate criteria.
- `allowed_tools`: Tool classes allowed for the phase.
- `kb_writes`: Knowledge base sections that must be updated.
- `human_gate`: Whether human approval is required.
- `requirement_execution_profile_refs`: Exact approved requirement ceiling references, including immutable hashes.
- `delivery_execution_profile_id`: For delivery work, the stable ID reserved for the one current pull-request or local-release profile. It is an identifier only, not a profile hash or reusable cross-delivery grant.
- `autonomy_phase_level`: Optional phase-specific level. It may narrow, never widen, the delivery selection.
- `execution_policy`: Codex runtime policy for model and reasoning inheritance or override.
- `capability_policy`: Skills, MCPs, tools, and approval-required actions agreed for the step.
- `capability_bindings`: Concrete project-local targets and permissions for required MCP/tool usage.
- `capability_recommendation_refs`: Approved capability recommendations that supplied policy, bindings, open questions, or execution-policy suggestions.
- `contextualization`: Project-specific summary, source files, questions, assumptions, and constraints.
- `audit`: Actor, Git, and run metadata for contract creation and updates.
- `approvals`: Human or CI gate decisions. The latest approved decision controls strict gate status only while its content hash still matches the contract and its approval source satisfies policy.

## Execution Policy

Use `execution_policy` to make agent execution settings explicit:

```json
{
  "execution_policy": {
    "runtime": "codex",
    "model": {
      "mode": "inherit",
      "value": null
    },
    "reasoning": {
      "mode": "inherit",
      "level": null
    },
    "notes": []
  }
}
```

`inherit` means spawned agents should reuse the main Codex thread settings. Use `override` only when the user or project KB has selected a specific Codex model or reasoning level for the contract.

## Capability Policy

Use `capability_policy`, `capability_bindings`, and `capability_recommendation_refs` when a step needs specific skills, MCPs, tools, endpoints, repositories, environments, models, or permissions. Required MCP/tool capabilities must have a binding or an explicit open contract question. Capability recommendations must be approved and fresh, and install-required capabilities require explicit install approval before a contract can use them. Do not store external tracker mappings as source of truth; keep the authoritative contract data in `.sdlc/`.

## Phase Contracts Vs Output Contracts

Phase/story contracts define the work boundary: inputs, outputs, validation, allowed tools, KB writes, human gate, and execution policy.

Output contracts define the project-approved artifact structure for a specific output type. They live in `.sdlc/output-contracts/registry.json` and are linked with:

- `artifact_type`;
- approved `template_id`;
- story and requirement links;
- `mode`: `reuse`, `delta`, or `new`;
- optional `phase`: the configured workflow phase by which the artifact must be linked;
- optional base artifact for deltas.

Approval prompts display every reference with its due phase. An omitted phase is shown as `legacy all-due`: it remains required at every intermediate strict gate. Phased references become due cumulatively through the trusted current story workflow position; future references are not requested or enforced until that phase is reached, while lifecycle-complete certification requires all of them.

Do not duplicate template structure inside every phase contract. Let the phase contract say which artifact must be produced, and let the output registry say how that artifact is structured and whether an existing artifact should be reused.

The CLI accepts output references as `type:template:mode[:phase]`. The original three-part form remains valid and preserves the legacy all-due behavior: an unphased reference is required at every strict gate. Phase-scoped references become due cumulatively in the bound workflow order. An intermediate strict gate requires references assigned to the current or an earlier phase and defers references assigned to future phases. A lifecycle-complete strict gate requires every output reference, including those assigned to later phases.

Approved contracts, approved templates, and linked artifacts carry hashes. If the approved content changes after approval or linking, strict gates fail until the contract, template, or artifact link is refreshed through the CLI.

Formal approval records should include `approval_source`, approver attribution, summary or evidence, and approved content hash. `explicit-user` means the user confirmed that specific artifact; it is not implied by permission to implement. `bootstrap` is reserved for migration/provisional records and does not satisfy strict gates unless the project explicitly allows it.

## Autonomy Policy

The business requirement and the autonomy policy are related but separate:

- `requirement:v2` captures the agreed outcome, boundaries, acceptance criteria, non-goals, NFRs, integrations, and revision lineage;
- `requirement-execution-profile:v1` sets the maximum autonomy for that immutable requirement revision;
- `delivery-execution-profile:v2` records the explicit choice for one `pull_request` or `local_release`, including its verification-provider bindings; historical `delivery-execution-profile:v1` records remain readable through the conservative in-memory compatibility mapping and are never rewritten;
- the contract can only narrow that delivery level for its phase.

Delivery binding is deliberately one-way. Reserve a stable `delivery_execution_profile_id` in the final contract, approve that contract, then create and approve the matching delivery profile against the immutable requirement-profile, story, and contract hashes. The contract does not hash-bind the delivery profile and is not rewritten after profile approval, which avoids a circular hash dependency.

The effective level is the most restrictive of host, project, requirement, delivery, contract, capability, environment, and budget. If a contract links multiple requirements, use the lowest ceiling. Missing, stale, expired, revoked, unknown, or materially drifted profile input blocks execution or falls back to the configured supervised legacy path; it never widens authority.

The levels are `supervised`, `checkpointed`, and `bounded-autonomous`. `bounded-autonomous` requires an external trusted host/CI Ed25519 receipt for the exact approval subject under `host_verified` policy; `audit_only` is capped at `checkpointed`, including for local release. Prior executions may justify a recommendation but cannot promote the level. Task start is automatic only for phases listed in the effective level's configured `automatic_phases`; `supervised` always confirms.

For `pull_request`, bind repository, base branch, head branch, explicit write paths, and exact canonical actions. For `local_release`, bind the local root, actions, write paths, shell-free JSON-argv smoke tests, and required rollback. Every new local release automatically requires `rollback.verify`: a checkpointed, non-executing receipt bound to the exact root, write paths, rollback procedure, and immutable rehearsal evidence before `release.local`. A reversible data change additionally requires the paired `data.migrate` and `data.rollback` actions, one exact regular-file target, exact logical scopes, immutable preview evidence outside mutable paths, one exact backup path, and final rollback verification. The CLI observes hashes and never executes a migration or rollback command. Each delivery profile contains exactly one story and its one approved contract; aggregate multi-story shipping through an agreed aggregation story/contract. Delivery profiles are exact-delivery, non-reusable, single-concurrent-run, receipt-backed, and terminally closed. Protected-branch merge and remote or production deployment remain explicit exceptions.

Execution actions are two-receipt operations: authorize the exact action/runtime/details, let the host or tool execute it, then complete with outcome and immutable evidence. The authorization receipt is not an executor. A checkpoint in `host_verified` mode requires an external Ed25519 receipt for `autonomy.delivery.action.<canonical-action>` bound to the exact action subject; `audit_only` records explicit approval without verified authority. Passing `release.local` or `pull_request.merge` completion creates the success close automatically. Push/merge also use live remote pre/post observations; retain durable host/CI/provider evidence because those observations are not provider-signed offline attestations.

## Template Source

The default contract templates are defined in `templates/sdlc-config.json` at the plugin root. Teams can fork or replace that file, then pass a custom template overlay directory through:

```bash
node <plugin-root>/bin/agentic-sdlc.mjs --template-dir <dir> ...
```

The overlay must contain a valid, readable `sdlc-config.json`. Other template assets are optional: when an asset is absent from the overlay, the CLI uses the matching bundled asset. `init` and the initialization part of `onboard existing-project` resolve and validate the configuration plus the knowledge-base README before writing the `.sdlc` bootstrap. Later commands resolve only the assets they need—for example, story creation resolves its plan and implementation-log templates—and reject an invalid selected asset before that command starts its own writes. Initialization does not proactively validate optional assets used only by later commands.

At `init`, the effective config is copied into the target project's `.sdlc/config.json`. Existing projects use that project-local policy for gate and orchestration commands, so later template-dir changes cannot silently weaken the process.

## Review Guidance

Reject or revise a contract when:

- it is not bound to a project;
- it does not record context sources or questions;
- outputs are not testable;
- validation criteria are subjective only;
- allowed tools are too broad for the risk level;
- requirement execution profile references are absent, stale, revoked, or do not match the requirement revision;
- delivery work does not reserve a stable `delivery_execution_profile_id` before contract approval;
- at task start, the matching delivery profile is absent, stale, reused, or does not bind this story and approved contract;
- requested, phase, or effective autonomy exceeds any host, project, requirement, delivery, capability, environment, or budget boundary;
- the evaluator reports effective `bounded-autonomous` under `audit_only` authority;
- a pull-request profile silently includes protected-branch merge or remote deployment;
- a local-release profile lacks an exact target, allowed writes/actions, smoke tests, or rollback;
- a declared local data migration lacks its paired migrate/rollback actions, exact target/scope, immutable preview, backup, or verified rollback-before-final-migration evidence;
- required capabilities have no binding and no open question;
- referenced capability recommendations are stale, unapproved, or missing install approval;
- execution policy overrides are present without rationale or user/project backing;
- linked output artifacts do not use approved output templates;
- duplicate outputs are created without an approved decision;
- the latest human gate decision is not `approved` before phase exit;
- approval source is missing, legacy-only, or bootstrap when strict gate requires explicit approval;
- audit metadata is missing for contract updates;
- human approval is missing for high-impact actions;
- KB writes are missing for decisions, assumptions, risks, or tests.
