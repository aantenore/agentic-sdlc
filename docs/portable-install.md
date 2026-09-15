# Portable Codex Install

Agentic SDLC 0.14.0 is a self-contained Codex plugin. The repository root is the plugin root because it contains `.codex-plugin/plugin.json`; all manifest and agent-card paths are repository-relative.

## Package Surface

The staged plugin contains:

```text
.codex-plugin/plugin.json
assets/
bin/
config/
docs/
lib/
schemas/
scripts/
skills/agentic-sdlc/
skills/agentic-sdlc-assessment/
skills/change-observatory/
skills/caveman/
templates/
ui/change-observatory/
LICENSE
package.json
README.md
```

The assessment, Change Observatory, and vendored Caveman skills include
`agents/openai.yaml`. Caveman `v1.9.1` is bundled with its MIT license and
provenance notice, so initial installs and updates need no separate Caveman
download. The first product starter remains:

```text
Contextualize this project and prepare an initial technical assessment.
```

The npm `files` allowlist defines the package surface. Project-specific `.sdlc/` data, repository tests, Git metadata, and unlisted root files do not travel with the plugin.

## Prerequisites

- Codex with the `codex plugin` command group.
- Node.js 18.20.3–18.x, 20.12.0–20.x, or 21.6.0+ for `bin/agentic-sdlc.mjs`. Earlier releases in those lines contain a native shutdown livelock fixed upstream.
- Python 3.8 or newer for the repository staging installer.
- A source checkout outside the generated `~/plugins/agentic-sdlc-codex-plugin` destination.
- Optional: RTK 0.43 or newer on `PATH` for the gateway's default automatic runtime route. The first candidate is canonicalized and must resolve outside the project root; project-local or configured custom providers require the explicit per-invocation trust switch described below.

Use `python3`, `python`, or `py -3` according to the Python 3 launcher available on the machine.

## Install

From the source checkout, first inspect the machine, then create a read-only
plan. Apply only the exact plan you just reviewed:

```bash
cd /path/to/agentic-sdlc-codex-plugin
python3 scripts/install-personal-marketplace-v2.py check
python3 scripts/install-personal-marketplace-v2.py plan --json
python3 scripts/install-personal-marketplace-v2.py apply --plan-hash <plan_hash-from-plan> --json
# Required: run candidate_registration.command.argv with its exact environment,
# then candidate_registration.verification.argv with its exact environment.
# Default target example only; do not use it for a custom returned target:
env HOME="$HOME" CODEX_HOME="$HOME/.codex" codex plugin add agentic-sdlc-codex-plugin@personal --json
env HOME="$HOME" CODEX_HOME="$HOME/.codex" codex plugin list --json
python3 scripts/install-personal-marketplace-v2.py validate --transaction-id <transaction_id-from-apply> --receipt-hash <receipt_hash-from-apply>
python3 scripts/install-personal-marketplace-v2.py confirm --transaction-id <transaction_id-from-apply> --receipt-hash <receipt_hash-from-apply>
python3 scripts/autoconfigure-token-efficiency.py apply --json
```

V2 is the canonical local installer. `check` and `plan` do not change files,
and running it without a command is also plan-only. `apply` recalculates the
plan while holding locks for both HOME and the selected Codex state directory,
rejects linked cache ancestors, records the exact prior installed-or-absent
Codex list/cache identity, stages and byte-verifies the new plugin, and retains
the byte-exact previous plugin and marketplace bytes. Before validation,
execute `technical_details.candidate_registration.command.argv` with exactly
its `environment`, then execute `verification.argv` with exactly its
`environment`. The two `env ... codex` lines above illustrate only the default
target; never substitute them when the returned executable, `HOME`, or
`CODEX_HOME` differs. Run the exact `validate` command returned by `apply`,
exercise the installed plugin, then run the returned `confirm` command to keep
the update or `restore` to recover the prior state. `confirm` verifies the
candidate Codex entry and cache identity before removing any recovery copy.
Restore is complete only after V2 has put the prior
staging and marketplace bytes back, used the official Codex add/remove command
to reproduce the exact prior state, and verified the resulting Codex list,
cache fingerprint, and installer provenance. If the Codex command is missing
or fails, V2 reports `staging_restored: true`,
`codex_reconciled: false`, and `partial_failure: true`; it keeps the
transaction open and returns the exact retry command. Codex is resolved from
`PATH` during `apply`; when a non-default target is required, pass
`--codex-executable /absolute/path/to/codex` and/or
`--codex-home /absolute/path` to `apply`. That target is receipt-bound and
cannot be changed during `confirm` or `restore`. The default target is
`<home>/.codex` and never inherits a different ambient `CODEX_HOME`. Every
transition is bound to the transaction ID and current receipt hash. Source
drift, destination drift, Codex-state drift, unexpected recovery data, or an
unproven interrupted state stops without overwriting it.

After confirmation, run the exact `post_confirm_autoconfigure_command` returned
by V2. The source-checkout form shown above performs the same checks. It:

- verifies that Caveman and the native Codex-session meter were installed with
  the plugin;
- verifies an existing RTK 0.43+ executable by version, byte hash, and gain
  contract;
- runs a private byte-bound RTK copy to configure and verify global Codex
  guidance;
- reports native fallback, without failing installation, when RTK is absent;
- never installs/configures CodeBurn and never uses network or authentication.

Autoconfiguration is outside V2's retained-backup boundary because RTK guidance
is user-global and can affect projects that do not use Agentic SDLC. It does
not download or upgrade RTK. For automatic runtime routing, put an approved RTK
binary on `PATH`; the gateway resolves and canonicalizes the first candidate
before execution. A PATH candidate or symlink target inside the project root
is inert by default. Alternatively, configure an absolute executable and pass
`--trust-custom-rtk-command` on each invocation that may execute it.

A successful list result contains an installed, enabled entry with:

```json
{
  "pluginId": "agentic-sdlc-codex-plugin@personal",
  "version": "0.14.0",
  "installed": true,
  "enabled": true
}
```

Start a new Codex task after installing. Existing tasks do not need to be treated as proof that the new skills and card were reloaded.

### Verify The Exact Build, Not Only The Version

The semantic version identifies a release line; it does not prove that two
plugin trees contain the same bytes. After staging or updating, inspect the
source checkout, generated staging copy, and Codex cache directly. Plugin
installation does not create a global `agentic-sdlc` shell command, so do not
use one as installation evidence:

```bash
# Run in the source checkout.
node bin/agentic-sdlc.mjs --version --json

# Run the installer-managed staging copy.
node "$HOME/plugins/agentic-sdlc-codex-plugin/bin/agentic-sdlc.mjs" --version --json

# Derive the cache path from staging; no release number is hard-coded.
VERSION="$(node -p 'require(process.argv[1]).version' "$HOME/plugins/agentic-sdlc-codex-plugin/package.json")"
# Use technical_details.codex_target.home from apply. This is the exact default;
# replace it only when apply bound an explicit --codex-home.
CODEX_STATE_HOME="$HOME/.codex"
CACHE_COMMAND="$CODEX_STATE_HOME/plugins/cache/personal/agentic-sdlc-codex-plugin/$VERSION/bin/agentic-sdlc.mjs"

# Run the exact cache loaded by Codex, including help; no global bin is assumed.
node "$CACHE_COMMAND" --version --json
node "$CACHE_COMMAND" --help
```

Each result contains at least:

```json
{
  "package_version": "0.14.0",
  "build_fingerprint": "<sha256-of-distributed-paths-and-bytes>",
  "git_commit": "<source-commit>",
  "git_dirty": false
}
```

Interpret the fields as follows:

| Field | Meaning | How to use it |
| --- | --- | --- |
| `package_version` | The declared semantic release | Confirm compatibility, but do not use it alone to claim two builds are identical |
| `build_fingerprint` | A deterministic SHA-256 over every distributed relative path and its exact bytes | Require the source and installed values to match when verifying that this exact checkout was installed |
| `git_commit` | The checkout `HEAD` that supplied the command, preserved by the official V2 installer | Require the source and officially installed values to match |
| `git_dirty` | Whether the source checkout had tracked or untracked changes when the install plan was created | Require `false` for a release build so the displayed commit fully describes the source |
| `provenance` | `official-installer-v2` when identity came from installer-managed metadata | Require this marker on both staging and cache when validating an installed copy outside Git |

The fingerprint excludes Git metadata, dependencies, runtime `.sdlc/` state,
coverage, other non-distributed directories, and the installer-generated
`.codex-plugin/build-provenance.json` file. Excluding only that metadata file
avoids a self-referential digest: its contents bind the source commit, dirty
state, package version, and fingerprint to the copied distribution. The
fingerprint remains stable when the same package bytes are copied to another
path, but changes when any distributed source, schema, template, skill, UI
asset, or document changes.

An arbitrary unpacked copy can still omit Git fields when it has neither a Git
checkout nor official installer provenance. The canonical V2 installation must
not omit them. Invalid, stale, or mismatched provenance fails closed. If any of
version, commit, dirty state, provenance marker, or fingerprint differs across
source, staging, and cache, do not treat the installed cache as verified: use
the still-open V2 transaction to restore, or rerun the reviewed update, then
open a new task and repeat all three identity commands.

### What The Installer Changes

The apply step:

1. reads the package allowlist and adds npm's standard root files;
2. builds a clean sibling staging directory;
3. verifies the reviewed plan is still current under a lock;
4. replaces `~/plugins/agentic-sdlc-codex-plugin` only when the destination is managed and safe;
5. creates or updates only this plugin's entry in `~/.agents/plugins/marketplace.json`;
6. retains byte-exact plugin and marketplace recovery data after apply;
7. confirms only after the receipt-bound candidate list/cache is verified, or restores the prior staging and marketplace bytes and the exact receipt-bound official Codex state before declaring success;
8. exposes a separate post-confirm token-efficiency autoconfiguration step.

V2 never modifies RTK's global Codex instruction profile. The separate
autoconfiguration command is the opt-in global change; it does not install RTK
or modify target-project evidence.

The script honors `HOME`. It refuses to traverse or replace a symlink, Windows junction/reparse point, Git checkout, source checkout, or directory with unmanaged top-level content and leaves that destination untouched for inspection.

Treat the generated tree under `~/plugins` as installation output. Do not clone into it, symlink it to the source, or update it with Git.

## Update

There is no dedicated update subcommand in the current Codex plugin CLI.
Refresh the source checkout by your normal source-control process, review a
fresh plan, apply that exact plan, and add the plugin again:

```bash
cd /path/to/agentic-sdlc-codex-plugin
python3 scripts/install-personal-marketplace-v2.py check
python3 scripts/install-personal-marketplace-v2.py plan --json
python3 scripts/install-personal-marketplace-v2.py apply --plan-hash <plan_hash-from-plan> --json
# Execute the exact candidate_registration argv/environment returned by apply.
# Default target example only:
env HOME="$HOME" CODEX_HOME="$HOME/.codex" codex plugin add agentic-sdlc-codex-plugin@personal --json
env HOME="$HOME" CODEX_HOME="$HOME/.codex" codex plugin list --json
python3 scripts/install-personal-marketplace-v2.py validate --transaction-id <transaction_id-from-apply> --receipt-hash <receipt_hash-from-apply>
python3 scripts/install-personal-marketplace-v2.py confirm --transaction-id <transaction_id-from-apply> --receipt-hash <receipt_hash-from-apply>
python3 scripts/autoconfigure-token-efficiency.py apply --json
```

Re-adding is supported and refreshes the installed cache. The installer replaces the complete managed staging tree, so files removed from the package do not remain stale. Start a new Codex task afterward.

For a released build, change the semantic version. During local development at the same version, the same staging-and-add sequence is the supported refresh workaround; a cachebuster is optional maintainer tooling, not an end-user update command.

## Uninstall

Remove the installed plugin and its Codex cache:

```bash
codex plugin remove agentic-sdlc-codex-plugin@personal
codex plugin list --json
```

This command does not delete:

- the source checkout;
- target-project `.sdlc/` knowledge;
- `~/plugins/agentic-sdlc-codex-plugin`;
- the catalog entry in `~/.agents/plugins/marketplace.json`.

It also leaves RTK's independent global Codex instructions in place. Remove
those only if they are no longer wanted by any project:

```bash
rtk init -g --codex --uninstall
rtk init -g --codex --show
```

That retained catalog entry allows a later reinstall. For permanent machine cleanup, first run the supported remove command, then delete only the generated plugin directory and remove only the matching plugin object from the personal marketplace JSON with a JSON-aware editor. Preserve unrelated entries and do not remove the shared `personal` marketplace source.

## Doctor

Run the plugin's non-destructive doctor from the source checkout. The npm script and direct CLI form execute the same checks:

```bash
npm run doctor
npm run doctor -- --root /path/to/target-project --json
node bin/agentic-sdlc.mjs doctor --root /path/to/target-project --json
```

Without `--root`, doctor checks the repository used as the current directory. With a target root, it also validates the project KB and output registry when `.sdlc/` exists. It returns a non-zero exit code when a check fails.

For installation and package diagnostics, combine it with:

```bash
codex plugin list --available --json
npm run check
npm pack --dry-run --json
```

Interpret the results as follows:

| Check | Expected result | Recovery |
| --- | --- | --- |
| `codex plugin list --available --json` | Installed entry is enabled and reports `0.14.0` | Rerun staging, add again, then open a new task |
| `npm run doctor` or CLI doctor | Reports runtime, version, assessment entry point, all four skills, Caveman/native-meter assets, Observatory launcher/UI, preset, optional RTK provider, and project KB checks as passed or not applicable | Repair a required failed item, restage, and open a new task |
| `npm run check` | JavaScript syntax checks pass | Repair the reported source syntax before reinstalling |
| Package dry run | Contains manifest, all four skills, agent cards, CLI, Observatory core/UI, schemas, and templates; excludes `.sdlc/` and `test/` | Repair `package.json` `files`, then restage |

If the staging script refuses the destination, inspect the printed path. Move or rename an unmanaged destination rather than forcing deletion; rerun the script only after the generated location is safe.

If the plugin is installed but `Project Assessment` is not visible, verify that the dry-run package includes `skills/agentic-sdlc-assessment/SKILL.md` and `skills/agentic-sdlc-assessment/agents/openai.yaml`, add the plugin again, and open a new Codex task.

### Maintainer Validators

When the Codex plugin and skill validator scripts are available locally, run them in an isolated `uv` environment so the validators receive their declared `PyYAML` dependency without modifying the plugin runtime:

```bash
uv run --with pyyaml python /path/to/plugin-creator/scripts/validate_plugin.py .
uv run --with pyyaml python /path/to/skill-creator/scripts/quick_validate.py skills/agentic-sdlc
uv run --with pyyaml python /path/to/skill-creator/scripts/quick_validate.py skills/agentic-sdlc-assessment
uv run --with pyyaml python /path/to/skill-creator/scripts/quick_validate.py skills/change-observatory
uv run --with pyyaml python /path/to/skill-creator/scripts/quick_validate.py skills/caveman
```

These are file validators, not Codex plugin subcommands. If `uv` is unavailable, use an isolated Python environment that already contains `PyYAML`; do not add it as a plugin runtime dependency.

## Installed-Journey Smoke Check

After installation, open a new Codex task in a disposable existing repository and submit:

```text
Contextualize this project and prepare an initial technical assessment.
```

The normal journey must expose no more than two decisions:

1. approve or correct the inferred project context;
2. approve or change one combined assessment proposal.

The combined proposal must name an explicit assessment story such as `ST-INITIAL-ASSESSMENT`. After approval, that story must exist before its contract or output, the approval must be persisted with `authorization grant`, and agent-driven approvals plus `task start --confirm-start` must use `--authorization <id>`.

The final delivery must include the real requested artifact, a concise chat summary, and a stored verification receipt. DOCX, XLSX, PDF, PPTX, and HTML links must also contain render or visual-check evidence.

Also submit this prompt in the disposable project:

```text
Open the Change Observatory for this project.
```

The installed skill must launch the plugin-local CLI, open or return a token-bearing loopback URL, render the bundled UI without a build, and leave the project tree unchanged. See [Change Observatory](change-observatory.md).

## Portability Boundaries

- The plugin is reusable code and method; target-project state remains in that project's `.sdlc/` directory.
- Cache and indexes are derived and are never accepted as canonical evidence.
- Installer V2 changes only the current user's plugin staging and personal marketplace files; it never changes global Codex instructions.
- The separate post-confirm autoconfiguration may refresh verified RTK global guidance; it never installs/upgrades RTK or configures CodeBurn.
- The plugin has no runtime npm dependencies.
- External tools needed for a requested artifact format are selected and disclosed in the assessment proposal; missing tools require a decision before installation.
