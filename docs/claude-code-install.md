# Claude Code installation

Agentic SDLC 0.112.0 ships two host packagings from one source tree:

| Host | Manifest | Command surface | Installer |
|---|---|---|---|
| Codex | `.codex-plugin/plugin.json` | skills + agent cards (`skills/*/agents/openai.yaml`) | `scripts/install-personal-marketplace-v2.py` |
| Claude Code | `.claude-plugin/plugin.json` | skills + slash commands (`commands/*.md`) | `/plugin marketplace add` |

Both read the same `skills/`, the same JSON schemas, the same templates, and the same Node.js CLI under `bin/`. There is no host-specific fork of the lifecycle logic: the CLI owns every gate, receipt, and record, and the host only supplies the conversation. When a command names no `--actor` or `--agent`, the CLI attributes the record to the host it detects from the environment (`claude-code` when `CLAUDECODE` is set, `codex` otherwise); set `AGENTIC_SDLC_AGENT_HOST` to `codex` or `claude-code` to choose explicitly.

## Prerequisite

Node.js **18.20.3–18.x, 20.12.0–20.x, or 21.6.0+**. Earlier releases in those lines contain an upstream native shutdown livelock.

```bash
node --version
```

## Install

```bash
/plugin marketplace add aantenore/agentic-sdlc
/plugin install agentic-sdlc@aantenore
```

The first command registers this repository as a plugin marketplace from its `.claude-plugin/marketplace.json`. The second installs the plugin itself. Claude Code clones the repository; nothing is written outside its own plugin directory, and no `.sdlc/` record is created until you run the lifecycle against a project.

To install from a local checkout instead:

```bash
git clone https://github.com/aantenore/agentic-sdlc.git
/plugin marketplace add /absolute/path/to/agentic-sdlc
/plugin install agentic-sdlc@aantenore
```

## Verify

```bash
/agentic-sdlc:doctor
```

The same check is available without the plugin surface:

```bash
node /path/to/agentic-sdlc/bin/agentic-sdlc.mjs doctor --json
```

A failed check exits non-zero and names the concrete fix.

## Slash commands

| Command | Starter intent |
|---|---|
| `/agentic-sdlc:assess` | Contextualize this project and prepare an initial technical assessment. |
| `/agentic-sdlc:deliver` | Turn this new requirement into an agreed work brief, implement it, verify it, and open a new pull request. |
| `/agentic-sdlc:continue-pr` | Continue this existing pull request, verify the requested changes, and update the PR without creating a new one. |
| `/agentic-sdlc:local` | Build and verify this result only on my local machine. Do not push, open a pull request, deploy, or use production. |
| `/agentic-sdlc:observe` | Open the Change Observatory and explain this project's recorded delivery lineage. |
| `/agentic-sdlc:status` | Show the current outcome, the decision that needs a person, and the next step. |
| `/agentic-sdlc:doctor` | Check the local setup and explain how to fix what is broken. |

The commands are entry points, not a second workflow. Each one delegates to the same skill a plain-language request would load, so `/agentic-sdlc:deliver add rate limiting to the public API` and describing that requirement in ordinary words follow the identical governed path.

## Skills

The plugin installs four skills, shared byte-for-byte with the Codex packaging:

- `agentic-sdlc` — the contract-driven lifecycle: requirement, work brief, autonomy, task start, implementation, verification, release evidence.
- `agentic-sdlc-assessment` — proposal-bound project contextualization and verified assessment artifacts.
- `change-observatory` — the local visual lineage app.
- `caveman` — optional response compression; it has no lifecycle role.

Claude Code loads a skill when the conversation matches its description, so the slash commands are a shortcut rather than a requirement.

## Hooks

The plugin ships one `hooks/hooks.json`, read by both Claude Code and Codex. It adds three guard rails around standing approvals. They are a second line of defence, not the only one: the CLI itself refuses `autonomy standing approve` inside an agent's session, standing-approval records are hash-sealed, and the shared state on the git remote is checked before every covered step. Neither the hooks nor those checks are a cryptographic guarantee: an agent that writes and runs a separate script can still approve a standing approval in an `audit_only` project. A project that needs the guarantee uses signed approvals (`host_verified`): a standing approval is then approved only with the trusted host's Ed25519 receipt for that exact record, which the CLI verifies when it is recorded, at every covered step, and in the strict gate, so a script without the host's key cannot approve one ([how it works](how-it-works.md#signed-standing-approvals)).

- **Only you approve a standing approval.** If the agent tries to run `autonomy standing approve` itself, the call is blocked and the agent hands you the exact command to run in your own terminal.
- **Standing approval records stay untouched.** Direct edits, deletions, or overwrites of `.sdlc/autonomy/standing/`, rewrites of the `refs/agentic-sdlc/` refs (which also hold the story claims shared across computers), `git clean` or `git stash -u` that would delete uncommitted `.sdlc` records, and clearing the variables that mark the agent's session are blocked; reading, staging, and committing the records stay allowed.
- **Each session starts informed.** When a project has standing approvals, the session starts with a short list: which are active, how many deliveries are left, and whether the shared state on the git remote can be reached.

Claude Code enables plugin hooks with the plugin. Codex asks you to review and trust new plugin hooks at startup ("Review hooks"); until you trust them they do not run, and a non-interactive Codex run needs them trusted beforehand. The hooks act only inside a project that uses agentic-sdlc (a `.sdlc` folder in the working directory or above it); in any other project they do nothing. A hook that fails or times out never blocks your work, and each check adds a short Node start-up to shell and edit calls.

## Path resolution

Slash commands reference the CLI through `${CLAUDE_PLUGIN_ROOT}`, which Claude Code substitutes with the installed plugin directory. Skill bodies do not rely on that substitution: each skill that runs the CLI (`agentic-sdlc`, `agentic-sdlc-assessment`, `change-observatory`) states that the plugin root is exactly two directories above its own `SKILL.md`, which works identically under a Claude install, a Codex install, and a plain `git clone`. The CLI also derives its own root from `import.meta.url` and reports it in `doctor --json` as `plugin_root`.

## Update

```bash
/plugin marketplace update aantenore
/plugin install agentic-sdlc@aantenore
```

Project behavior does not change silently on update: each initialized project pins its configuration, and a plugin upgrade requires an explicit reviewed migration plan. See [Configuration safety](configuration-safety.md).

## Uninstall

```bash
/plugin uninstall agentic-sdlc@aantenore
/plugin marketplace remove aantenore
```

This removes the plugin only. Every `.sdlc/` record stays in the project repository where it belongs, because project state is versioned with the code rather than with the plugin.

## What does not apply on Claude Code

- `scripts/install-personal-marketplace-v2.py` is the Codex transactional installer. It stages into `~/plugins` and registers in `~/.agents/plugins/marketplace.json`, and it is not used by Claude Code.
- `scripts/autoconfigure-token-efficiency.py` writes global Codex instructions for RTK. It is optional and Codex-specific.
- The native session meter in `docs/codex-session-metering.md` reads Codex session logs. On Claude Code, use explicit limits from [Limits and metering](limits-and-metering.md) instead; the budget model itself is host-independent. Record usage with `agentic-sdlc budget usage record --proposal <id> --input-tokens <n> --output-tokens <n>`, or enable the CodeBurn adapter with this host's log provider and pin the configuration with `config migrate`. `budget meter start` without a Codex task explains the same options.

## Troubleshooting

| Symptom | Check | Fix |
|---|---|---|
| Slash commands do not appear | `/plugin` lists `agentic-sdlc` as enabled | Reinstall, then start a new conversation so the plugin surface reloads |
| `node: command not found` in a command | `node --version` | Install a supported Node.js runtime and restart the client |
| A command runs but every record is refused | `/agentic-sdlc:status` | The project is probably not initialized; run `init` or `onboard` first |
| The Observatory URL returns 401 | The full URL including the `#access_token=` fragment was opened | Re-open the exact URL the CLI printed; the token is per-run and lives in the fragment |
