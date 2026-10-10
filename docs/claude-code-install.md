# Claude Code installation

Agentic SDLC 0.146.6 ships two host packagings from one source tree:

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
- **Orchestrator mode (opt-in).** Set `host_policy.main_thread` to `"orchestrator"` in `.sdlc/config.json` (default `"free"`) and the session starts with an instruction: the main thread only coordinates (messages, decisions, checking results, single quick read-only commands). The main thread must never block: any command that might take more than about 10 seconds (tests, builds, plugin updates, publish, fetch) is launched in the background (Claude Code: Bash `run_in_background`, Codex: the equivalent) or delegated to a subagent, and only quick read-only commands run in the foreground. Work that needs reasoning (code, fixes, story delivery, review) goes to background subagents; mechanical work (builds, test suites, dev servers, long commands) goes to controlled background processes, meaning an explicit deadline, no orphaned `nohup` or `&`, output in a file read at the end, and a final check that no process is left running. An `Edit`, `Write`, or `NotebookEdit` made from the main thread, recognised by the missing `agent_id` in the hook payload, gets a warning; nothing is blocked, and subagents and shell commands are never touched.
- **Strict main thread (opt-in, enforced).** Set `AGENTIC_SDLC_MAIN_THREAD=strict` in your user environment (or `host_policy.main_thread` to `"strict"` per project); the variable (`free|orchestrator|strict`) takes precedence over the project value. On the main thread only (no `agent_id` in the hook payload), `Edit`, `Write`, and `NotebookEdit` are denied, and `Bash` is denied unless it runs with `run_in_background: true` or every segment of the command (split on `|`, `&&`, `||`, `;`) is on the read-only allowlist: `ls`, `cat`, `head`, `tail`, `wc`, `grep`, `rg`, `find` (without `-exec` or `-delete`), `jq`, `ps`, `pwd`, `echo`, `date`, `which`, `git status|log|diff|show|branch|fetch|rev-parse|ls-tree|worktree list`, `gh pr view|list|checks`, the plugin `message send|read|who`, `story working`, `status` commands, and `claude plugin`. Redirection to a file, command substitution, and a trailing `&` are always denied (only `/dev/null` is accepted). `AGENTIC_SDLC_MAIN_THREAD_ALLOW` adds regexes (one per line or separated by `;;`), each matched against the start of a segment. Subagents and the `Agent`, `Read`, `Grep`, `Glob`, and `SendMessage` tools are never touched. The hooks act only inside a project that uses agentic-sdlc.

- **Processes left running (warning by default, opt-in cleanup).** Every session in a project that uses agentic-sdlc starts with a short instruction: long commands go through `agentic-sdlc run --timeout <duration> [--log <file>] -- <command>` (or run in the background with a deadline), never `nohup` or `&` without a deadline, and at the end of the work the agent runs `agentic-sdlc processes reap`. `run` works on macOS, Linux and Windows without extra tools: at the deadline it stops the command and everything it started (a process group on POSIX, `taskkill /T /F` on Windows), prints a clear message and exits with 124; otherwise standard input and output pass through and the command's exit code is returned. `processes reap [--older-than 10m] [--dry-run] [--json]` stops this user's development processes (tests, builds, `next dev`, plugin commands, `sleep`) that run longer than the limit and whose command line contains the project root, one of its git worktrees or the plugin cache: SIGTERM, then SIGKILL after 5 seconds (Windows: `taskkill /T /F`, process list from `Get-CimInstance Win32_Process`, `wmic` as a fallback; on Windows the scope is the folder, not the owner). It never touches `observe`, `message listen`, `run` wrappers, a pattern listed in `exclude_patterns`, itself or its parent processes. At the end of every turn the Stop hook looks (dry run) and, when something is over the limit, adds one short warning ("N processi oltre X min: ..., esegui processes reap"), at most once every 5 minutes; with `AGENTIC_SDLC_REAP_ON_STOP=1` (or `reap_on_stop: true`) it stops those processes instead. Configure it in `.sdlc/config.json` under `host_policy.process_reaper`: `older_than_minutes` (default 10), `include_patterns` and `exclude_patterns` (case-insensitive regular expressions on the command line, added to the built-in ones in `config/process-reaper.json`; `use_default_patterns: false` drops the built-in include list), `scope_paths` (extra folders), `reap_on_stop`. `AGENTIC_SDLC_REAP_EXCLUDE` adds exclusions (newline or `;;` separated), for example the port of a dev server you keep running.

Claude Code enables plugin hooks with the plugin. Codex asks you to review and trust new plugin hooks at startup ("Review hooks"); until you trust them they do not run, and a non-interactive Codex run needs them trusted beforehand. The hooks act only inside a project that uses agentic-sdlc (a `.sdlc` folder in the working directory or above it); in any other project they do nothing. A hook that fails or times out never blocks your work, and each check adds a short Node start-up to shell and edit calls.

## Path resolution

Slash commands reference the CLI through `${CLAUDE_PLUGIN_ROOT}`, which Claude Code substitutes with the installed plugin directory. Skill bodies do not rely on that substitution: each skill that runs the CLI (`agentic-sdlc`, `agentic-sdlc-assessment`, `change-observatory`) states that the plugin root is exactly two directories above its own `SKILL.md`, which works identically under a Claude install, a Codex install, and a plain `git clone`. The CLI also derives its own root from `import.meta.url` and reports it in `doctor --json` as `plugin_root`.

## Update

```bash
/plugin marketplace update aantenore
/plugin install agentic-sdlc@aantenore
```

Project behavior does not change silently on update: each initialized project pins its configuration, and a plugin upgrade requires an explicit reviewed migration plan. See [Configuration safety](configuration-safety.md).

## Autonomous update (opt-in)

Set `AGENTIC_SDLC_AUTO_UPDATE=1` in the environment of the computer to enable all of the following; without it nothing below runs.

- **Update.** At SessionStart and Stop (at most every 15 minutes), and as soon as a channel message announces a newer agentic-sdlc release, the hook starts, detached and non-blocking, `claude plugin marketplace update <marketplace>` then `claude plugin update agentic-sdlc@<marketplace>`, within 120 seconds in total. The marketplace is read from the install path (`plugins/cache/<marketplace>/agentic-sdlc/<version>`), else from the plugin's `marketplace.json`. The throttle timestamp, the remembered session folders and the log (`agentic-sdlc-auto-update.log`) live in `$CLAUDE_PLUGIN_DATA`, or in `~/.claude`. Tunables: `AGENTIC_SDLC_AUTO_UPDATE_INTERVAL_MINUTES` (15), `AGENTIC_SDLC_AUTO_UPDATE_TIMEOUT_SECONDS` (120), `AGENTIC_SDLC_AUTO_UPDATE_CLAUDE_BIN` (`claude`).
- **No reload for hooks and CLI.** The hook entry and `bin/agentic-sdlc.mjs` look for a newer semver folder next to the plugin root in the cache and run the same file of that version, passing stdin, arguments and exit code through; `AGENTIC_SDLC_FORWARDED` prevents forwarding loops.
- **Files synced in place.** After an update (and at each SessionStart/Stop), the files of the newer version in `skills/`, `commands/`, `hooks/`, `lib/`, `bin/`, `templates/`, `schemas/` and `docs/` are copied over the folder the session uses (each file is written to a temp file, then renamed; a `.agentic-sdlc-synced-version` marker avoids repeating the copy). This happens only when that folder is inside the plugin cache and the source is a sibling with a higher version. Override the list with `AGENTIC_SDLC_AUTO_UPDATE_SYNC_DIRS` (comma-separated). Skill bodies and slash command texts are meant to be read from disk when invoked, so they should refresh without a reload; new skills or commands and changed descriptions in the listing still need `/reload-plugins` or a new session.
- **Codex.** Not covered: there is no CLI equivalent of `claude plugin update`, so keep using the transactional installer.

## Repositories outside the guard (opt-in)

`AGENTIC_SDLC_UNGOVERNED_REPOS` holds absolute repository paths separated by the OS path separator (`:` on macOS/Linux, `;` on Windows). The guard does not block a push or `gh pr merge` when the git toplevel of the working directory (or of the `git -C` target) is one of them. Every other repository keeps the current behavior.

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
