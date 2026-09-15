# Agentic SDLC documentation

This page is the documentation map. Start with the goal that matches what you want to do; you do not need to read every page in order.

## Start here

- [Getting started](getting-started.md) — choose a natural-language starter, understand what you will approve, and distinguish a new PR, an existing PR, and a local-only result.
- [Project overview](../README.md) — what the plugin does, installation, the normal two-checkpoint experience, and maintainer commands.
- [How it works](how-it-works.md) — the advanced lifecycle from project context and requirement agreement through per-delivery autonomy, execution, verification, and release evidence.
- [Limits and metering](limits-and-metering.md) — how requirement ceilings and explicit pull-request or local-release choices constrain actions, files, capabilities, time, steps, tokens, calls, cost, and custom metrics.
- [Change Observatory](change-observatory.md) — open and interpret the bundled visual request/change/decision lineage.
- [Token efficiency](token-efficiency.md) — reduce derived JSON and shell-output context without changing canonical evidence.
- [Configuration safety](configuration-safety.md) — keep project policy stable across plugin updates and apply only a reviewed migration plan.
- [Self-service CLI](self-service-cli.md) — get focused help, one next action, safe presentation presets, shell completion, and deterministic JSON without learning internal record names.
- [Claude Code installation](claude-code-install.md) — install, verify, and use the plugin from Claude Code, and see which Codex-only steps do not apply.
- [Configurable workflows](configurable-workflows.md) — use governed project, change-request, assessment, or generic processes without changing active history or delivery authority.

## Find a page by goal

| I want to... | Read this | What it answers |
|---|---|---|
| Start without learning internal record names | [Getting started](getting-started.md) | What to ask Codex, the novice journey, and the decisions you will see |
| Deliver a new requirement as a new pull request | [Getting started — New pull request](getting-started.md#new-requirement-and-new-pull-request) | Requirement, work brief, branch boundary, autonomy, implementation, verification, and PR creation |
| Continue a pull request that already exists | [Getting started — Existing pull request](getting-started.md#continue-an-existing-pull-request) | How the exact PR is identified and updated without creating another one |
| Produce a result only on this machine | [Getting started — Local-only result](getting-started.md#local-only-result-or-release) | Which local writes and checks are allowed and which network/production actions remain excluded |
| Understand the normal user journey | [How it works](how-it-works.md) | What happens at each checkpoint and which records are created |
| Run or explain an assessment | [Assessment interactions](agent-interactions.md) | What Codex asks, what the user must answer, and concrete examples |
| Choose autonomy for a requirement, pull request, or local release | [Limits and metering](limits-and-metering.md) | Requirement ceiling, per-delivery selection, local rollback, exception boundaries, and resource limits |
| Measure the exact local Codex task | [Native Codex session meter](codex-session-metering.md) | Authentication-free local counters, task binding, deltas, and limit semantics |
| Keep a legacy CodeBurn project working | [CodeBurn adapter reference](codeburn-metering.md) | Disabled-by-default compatibility, snapshot/delta contracts, and library APIs |
| Reduce command and response tokens | [Token efficiency](token-efficiency.md) | Compact JSON, RTK, Caveman, autoconfiguration, and measured net usage |
| Keep behavior stable across plugin updates | [Configuration safety](configuration-safety.md) | Config locks, safe previews, drift recovery, and exact plan application |
| Select or customize a governed process | [Configurable workflows](configurable-workflows.md) | Built-in presets, safe overlays, pinned instances, append-only events, and CLI examples |
| Understand the architecture and trust model | [Architecture](architecture.md) | Components, canonical records, validation, and release evidence |
| Open visual project lineage | [Change Observatory](change-observatory.md) | Launch paths, explainability, raw evidence, and local security boundaries |
| Find the next command or use machine output | [Self-service CLI](self-service-cli.md) | Focused help, compact status, safe presets, completion, and local plan/apply updates |
| Understand `.sdlc/` storage | [Knowledge-base structure](kb-structure.md) | Which files are canonical, derived, append-only, or releasable |
| Install, update, or repair the plugin on Codex | [Portable install](portable-install.md) | Cross-platform installation, local marketplace setup, and troubleshooting |
| Install, update, or repair the plugin on Claude Code | [Claude Code installation](claude-code-install.md) | Marketplace install, slash commands, path resolution, and Codex-only steps that do not apply |
| Understand the product assessment | [Product assessment](product-assessment.md) | Product intent, strengths, gaps, and improvement direction |

## Recommended reading paths

### New to the plugin

1. [Getting started](getting-started.md)
2. [How it works](how-it-works.md), only when you need the protocol details
3. [Self-service CLI](self-service-cli.md), only when operating or recovering from the command line

### User approving work

1. [Getting started](getting-started.md)
2. [How it works](how-it-works.md)
3. [Assessment interactions](agent-interactions.md)
4. [Limits and metering](limits-and-metering.md)

### Operator configuring controls

1. [Limits and metering](limits-and-metering.md)
2. [Architecture](architecture.md)
3. [Knowledge-base structure](kb-structure.md)
4. [Configurable workflows](configurable-workflows.md)
5. [Native Codex session meter](codex-session-metering.md)
6. [CodeBurn adapter reference](codeburn-metering.md), only for legacy configurations

### Maintainer changing the plugin

1. [Project overview](../README.md)
2. [Architecture](architecture.md)
3. [Change Observatory](change-observatory.md)
4. [Configurable workflows](configurable-workflows.md)
5. [Token efficiency](token-efficiency.md)
6. [Knowledge-base structure](kb-structure.md)
7. [Portable install](portable-install.md)

## The core idea in one diagram

```mermaid
flowchart LR
    A["Approved project context"] --> B["One immutable proposal"]
    B --> C["Exact authorization"]
    C --> D["Budgeted execution"]
    D --> E["Verified artifact"]
    E --> F["Release evidence"]
    D -->|"limit or trust problem"| X["exception_pending"]
    X -->|"approved amendment"| D
    X -->|"partial delivery"| E
    X -->|"stop"| S["Stopped"]
```

The proposal says what may happen. The authorization permits only the proposal’s exact action-and-subject pairs. The budget says how much measurable work may happen. Receipts prove what was actually used. For a detailed walkthrough, continue with [How it works](how-it-works.md); for the control model, continue with [Limits and metering](limits-and-metering.md).
