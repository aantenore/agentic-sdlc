# Self-service CLI

The command line starts with the answer a person needs, even when they do not
know the plugin's internal model. Human output always explains:

1. what happened;
2. what changes in practice;
3. whether you need to decide anything;
4. what remains protected;
5. the next useful step.

Record IDs, stored policy labels, paths, hashes, and diagnostic codes appear
after **Technical details (optional)**. JSON retains those fields for
automation.

Codex plugin installation does not create a global `agentic-sdlc` executable.
In the examples below, that name is shorthand for the installer-managed entry
point:

```bash
PLUGIN_CLI="$HOME/plugins/agentic-sdlc-codex-plugin/bin/agentic-sdlc.mjs"
node "$PLUGIN_CLI" help
```

An npm installation may expose the same CLI through its npm bin shim. To test
the exact Codex cache instead, derive the version and cache root as shown in
[Portable Installation](portable-install.md#verify-the-exact-build-not-only-the-version).

## Find the right command

Focused help works outside an initialized project and follows the command
hierarchy:

```bash
node "$PLUGIN_CLI" help
node "$PLUGIN_CLI" help autonomy
node "$PLUGIN_CLI" help autonomy delivery
node "$PLUGIN_CLI" help autonomy delivery approve --locale it
```

Use `status` when you only want to know what needs attention now:

```bash
node "$PLUGIN_CLI" status
node "$PLUGIN_CLI" status --locale it
node "$PLUGIN_CLI" status --json
```

The human view gives one recommended next action. The JSON view preserves the
existing project and count fields, adds `schema_version: cli-status:v1`, and
includes the same summary and next action in a stable machine-readable shape.

## Choose presentation without changing authority

Built-in presets change only language and presentation:

```bash
node "$PLUGIN_CLI" preset list
node "$PLUGIN_CLI" preset show human-it
node "$PLUGIN_CLI" status --cli-preset human-it
node "$PLUGIN_CLI" status --cli-preset machine
```

The built-ins are `human-en`, `human-it`, `machine`, `diagnostic`, and
`no-browser`. Explicit command options win over preset values.

A preset cannot choose a command, approve work, widen a path, select a target,
or add an execution flag. Import rejects every option outside the presentation
allowlist before accessing project state. This keeps a shared preset from
quietly changing what the plugin is allowed to do.

Export is deterministic, so the same preset produces byte-identical JSON:

```bash
node "$PLUGIN_CLI" preset export human-it
node "$PLUGIN_CLI" preset export human-it > human-it.json
node "$PLUGIN_CLI" status --cli-preset @human-it.json
```

The exported file is directly reimportable. Import validates its schema and
presentation-only allowlist before reading project state.

## Enable shell completion

Completion generation is deterministic and does not evaluate project files:

```bash
node "$PLUGIN_CLI" completion bash
node "$PLUGIN_CLI" completion zsh
node "$PLUGIN_CLI" completion fish
node "$PLUGIN_CLI" completion powershell
```

Load or install the printed script using the normal completion mechanism for
your shell. Regenerate it after upgrading if the command catalog changes.

## Understand an autonomy answer

The primary message uses ordinary language. For example, it says that the
requirement defines the most freedom a future change may request, while every
pull request or local release still receives its own separate choice. If the
current installation can only record who approved the work, it explains that
the agent must stop at the named checkpoints unless a trusted host supplies a
signed approval for that exact delivery.

Only the optional technical section names stored values such as
`bounded-autonomous`, `audit_only`, the delivery-profile ID, or receipt paths.
Those values remain available for audit and automation without making them a
prerequisite for understanding the decision.

## Check phase readiness

`assessment status`, `breakdown status`, `breakdown policy show`, and
`capability profile status` read local records only. None of them changes a
file, publishes, merges, deploys, or approves anything.

```bash
node "$PLUGIN_CLI" assessment status --id ASSESS-001
node "$PLUGIN_CLI" breakdown status --requirement REQ-001
node "$PLUGIN_CLI" breakdown policy show
node "$PLUGIN_CLI" capability profile status --profile CAP-PROFILE-ST-001
```

Omit the selecting option to list every matching record instead of one:

```bash
node "$PLUGIN_CLI" assessment status
node "$PLUGIN_CLI" breakdown status
node "$PLUGIN_CLI" capability profile status
```

| Command | Answers | Selects one record with |
|---|---|---|
| `assessment status` | Which checkpoint the assessment proposal has reached, its budget status, and the next recommended action | `--id <id>` |
| `breakdown status` | Whether a requirement's work has been proposed and approved as a breakdown | `--requirement <requirement-id>` (repeatable) |
| `breakdown policy show` | The work-splitting policy currently in effect: delivery unit, strict-gate unit, levels, and claimable units | — |
| `capability profile status` | Whether a tool-selection context has been proposed for a profile, and how many recommendations exist | `--profile <profile-id>` |

For a delegated authorization, use `authorization status` and
`authorization revoke` instead; see
[Check and revoke a delegated authorization](limits-and-metering.md#check-and-revoke-a-delegated-authorization).

`breakdown policy set` (effect: local) recomputes the effective
work-splitting policy — hard-coded defaults merged with any project
configuration — and commits that snapshot to
`.sdlc/work-breakdown/project-policy.json`:

```bash
node "$PLUGIN_CLI" breakdown policy set --root /path/to/project
```

Run without options it re-records the policy already in effect. To change the
policy, name the new values explicitly:

```bash
node "$PLUGIN_CLI" breakdown policy set --root /path/to/project \
  --levels epic --levels story --levels task \
  --default-flow epic,story,task \
  --delivery-unit story \
  --strict-gate-unit story
```

`--levels` is repeatable and lists every work-item level the project uses.
`--default-flow` sets the order they are normally created in. `--delivery-unit`
chooses the level that counts as one deliverable, and `--strict-gate-unit`
chooses the level the strict validation gate applies to. `--task-gate` selects
the task-level gate mode.

## Record the evidence of a test run

`test record` (effect: local) turns the result of one executed test run into a
durable story record under `.sdlc/tests/`. It records a run that already
happened; it never executes the command.

```bash
node "$PLUGIN_CLI" test record --root /path/to/project \
  --story ST-BOOKING-001 \
  --command '["npm","test"]' \
  --exit-code 0 \
  --passed 42 --skipped 1 \
  --evidence .sdlc/tests/ST-BOOKING-001-run.log \
  --framework node:test \
  --summary "Full suite on the reviewed implementation branch"
```

| Input | Purpose |
|---|---|
| `--story` | The story the run belongs to; it must already exist. |
| `--command` | The exact command that ran, as a JSON argument vector. |
| `--exit-code` | The status the command returned, `0`–`255`. |
| `--evidence` | The runner output, saved as a file inside the project. Repeatable, and at least one file is mandatory. |
| `--passed`, `--failed`, `--skipped` | The result counts; each defaults to `0`. |
| `--framework`, `--cwd`, `--started-at` | Optional context: the runner, the directory it ran in, and when it began. |
| `--requirement`, `--acceptance` | Link the run to the requirements and acceptance criteria it exercises. |

The outcome is not an input. It is derived from the exit status and the counts:
a zero exit status with no failures and at least one passing case is `passed`,
a zero exit status with nothing executed is `skipped`, and anything else is
`failed`. Each evidence file is hashed when the record is written, so a later
edit to that file is detectable.

## Scan a delivery for credentials

`secret scan` (effect: local) searches the files one delivery changed for
credentials and writes the result as a durable story record under
`.sdlc/security/`.

```bash
node "$PLUGIN_CLI" secret scan --root /path/to/project \
  --story ST-BOOKING-001
```

| Input | Purpose |
|---|---|
| `--story` | The story the delivery belongs to; it must already exist. |
| `--base`, `--head` | The exact commits to compare. `--base` defaults to the commit the story's task start recorded and `--head` to the current `HEAD`. |
| `--delivery` | Bind the record to one exact delivery. |
| `--summary`, `--id` | Optional text and an explicit record ID. |
| `--requirement` | Link the scan to the requirements the delivery serves. |

The changed files come from the commit range when one is available, from the
uncommitted workspace when the work is not committed yet, and from the story's
approved write paths for a local release with neither. Files are read through
the project path-safety boundary: nothing outside the project root is opened and
no symlink is followed.

Matches are printed and stored redacted, as the rule that matched plus at most
four leading characters. A scan that finds nothing exits `0`; a scan with
findings exits `1`, the refused-request status, so a pipeline gating on the exit
code blocks the delivery. Remove the credential from the file, rotate it at its
provider, then scan again.

The rules are project configuration. `gate_policy.secret_scan.rules` is an array
of `{ "id", "pattern", "flags" }` entries merged over the shipped defaults by
`id`, so one default can be retuned without restating the rest, and
`gate_policy.secret_scan.exclude_paths` lists path globs to leave out. The
shipped defaults cover AWS access key IDs and secret keys, GitHub `ghp_`,
`gho_`, and `github_pat_` tokens, Slack `xox[abp]-` tokens, private key blocks,
and credential literals assigned to an `api_key`, `secret`, `token`, or
`password` name.

When `gate_policy.secret_scan.enabled` is `true`, a story in validation needs a
`secret-scan:v1` record whose outcome is `clean` for the project's current head,
and the validation gate reports an error otherwise. The flag is read as an
explicit `true`: a project whose configuration never declared it keeps the gate
it agreed to, and adopts the check by initializing from the current template or
migrating through `config migrate`.

Writing the record also appends a `test` trace event carrying the same outcome,
so the run appears in the story history without a separate `trace append`.

## Read the exit code in a pipeline

A script that gates on this CLI usually does not parse its output. The exit
code alone says what happened, and it distinguishes the cases that need
different responses: a rejected input is the author's problem, a governance
denial is a decision somebody has to make, and an unreadable installation is an
operator problem.

| Exit code | Meaning | Typical response |
|---|---|---|
| `0` | The command completed. | Continue. |
| `1` | User error: the request was understood and refused on its merits. | Correct the request and retry. |
| `2` | Usage error: the command or its options could not be resolved. | Fix the invocation; `help` lists the real options. |
| `3` | Governance denial: an agreed limit or policy refused the action. | A person decides whether to amend the agreement. Do not retry unchanged. |
| `4` | Environment error: the host cannot run this software as installed. | Repair the installation; `doctor` names the fix. |
| `70` | Internal error: the software failed in a way the caller cannot correct. | Report it with the correlation ID from the output. |

A command killed by a signal keeps the conventional `128 + signal` form, so a
subprocess interrupted with `SIGINT` exits `130`.

When a project's privacy configuration withholds error details, the exit code
withholds them too: those failures report `1` rather than disclosing through
the exit code the category the message refuses to name.

```bash
node "$PLUGIN_CLI" gate check --root /path/to/project --scope all --json
case $? in
  0) echo "ready" ;;
  3) echo "blocked by an agreed limit; escalate to a person" ;;
  *) echo "fix the invocation or the project, then retry" ;;
esac
```

## Install or update locally

The local installer uses a reviewable transaction:

```bash
python3 scripts/install-personal-marketplace-v2.py check --locale it
python3 scripts/install-personal-marketplace-v2.py plan --locale it --json
python3 scripts/install-personal-marketplace-v2.py apply --locale it --plan-hash <plan_hash-from-plan> --json
# Required: execute candidate_registration.command.argv with its exact
# command.environment, then verification.argv with verification.environment.
# Default target example only; never use it for a custom returned target:
env HOME="$HOME" CODEX_HOME="$HOME/.codex" codex plugin add agentic-sdlc-codex-plugin@personal --json
env HOME="$HOME" CODEX_HOME="$HOME/.codex" codex plugin list --json
python3 scripts/install-personal-marketplace-v2.py validate --locale it --transaction-id <transaction_id-from-apply> --receipt-hash <receipt_hash-from-apply>
python3 scripts/install-personal-marketplace-v2.py confirm --locale it --transaction-id <transaction_id-from-apply> --receipt-hash <receipt_hash-from-apply>
python3 scripts/autoconfigure-token-efficiency.py apply --json
```

V2 is the canonical local installer. `check` and `plan` never write. With no
command, it also creates a plan only. `apply` accepts one exact plan hash,
recalculates it under a lock, stages and byte-verifies the package, and retains
the prior plugin plus marketplace bytes. `validate` proves the installed state
still matches the receipt. Refresh and inspect the official Codex copy before
`confirm`: confirmation verifies that candidate list/cache before removing
recovery data. The returned `restore` command instead restores the byte-exact
previous local and Codex state. Unexpected data stops recovery without being
overwritten. Use `--home /absolute/path` to inspect or manage another explicit
destination. The two `env ... codex` lines above are only a default-target
illustration. When `--home`, `--codex-home`, or `--codex-executable` selects a
non-default target, do not execute those lines and do not reconstruct a bare
`codex plugin add` command. Execute exclusively
`technical_details.candidate_registration.command.argv` with its exact
`environment`, followed by `candidate_registration.verification.argv` with its
exact `environment`, before `validate`.

V2 never changes global settings. After it is confirmed, the separate
token-efficiency command verifies bundled Caveman and native-meter files, then
configures an existing RTK binary through a private copy whose bytes match the
verified executable. It does not download/upgrade RTK, configure CodeBurn, use
the network, or authenticate. This step changes the current user's global Codex
instructions for every project; it is intentionally outside V2's
retained-backup boundary.
See [Portable install](portable-install.md) for supported environments, trust
boundaries, removal, and recovery.
