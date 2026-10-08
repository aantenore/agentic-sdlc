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
node "$PLUGIN_CLI" help autonomy standing
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
The human view labels each counter in plain words (for example "Decisions
waiting for you"); the JSON keys below are unchanged.

Two conditions come before any other next action, because nothing else can
proceed safely until they are resolved:

- a history file that no longer matches its recorded fingerprints
  (`next_action.kind: repair_history`, suggested command `trace verify`);
- configuration edited after it was last confirmed
  (`next_action.kind: migrate_config`, suggested command `config migrate`),
  or a configuration that cannot be verified (`repair_config`).

The JSON view also reports `history_integrity` and `configuration.status`.
Status uses a cheap consistency check of the history (`check: "quick"`) with
the status `verified`, `recovery_needed` (an interrupted recording that the
next event repairs automatically), or `violated`; `trace verify` runs the full
check. Proposals that wait for a
person, such as a proposed requirement, breakdown, dependency order, delivery
autonomy profile, workflow definition or overlay, or standing approval, count
as pending decisions and appear in `approval requests` with the exact approve
command. Status presents stored records under the project's privacy rules, so
the Git email recorded at initialization is shown as `[REDACTED]`; the stored
files themselves are not rewritten.

The summary counts `available_work`, `active_work`, `blocked_work`,
`stale_claims`, `completed_work` (stories with a valid or historical final
lifecycle certification), and `closed_work` (stories closed with `story
supersede` or `story cancel`, including a started story whose deliveries all
ended without delivered work). Closed stories are never counted as
available or blocked work. A certified story whose files changed after its
final check is not counted as completed: `status` points to the
lifecycle-complete gate that re-verifies it. The exception is a change that a
later story certified: when every differing certified path holds exactly the
content of another story's valid final receipt sealed later, the earlier story
stays completed and the JSON view lists it under `historical_certifications`
with the superseding story IDs.

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
| `--base`, `--head` | The exact commits to compare. `--base` defaults to the commit the story's task start recorded and `--head` to the current `HEAD`. The gate only accepts a scan whose base is the task-start commit or an ancestor of it, so a later `--base` cannot hide a change the delivery already committed. |
| `--delivery` | Bind the record to one exact delivery. |
| `--summary`, `--id` | Optional text and an explicit record ID. |
| `--requirement` | Link the scan to the requirements the delivery serves. |

The changed files come from the commit range when one is available, together
with every uncommitted and untracked file, from the uncommitted workspace alone
when there is no base to compare against, and from the story's approved write
paths for a local release with neither. A repository without its first commit
is scanned from its working tree, and the record names no head commit. A story
that started in such a repository records Git's empty tree as its delivery base,
so after the first commit the default range runs from the empty tree and covers
every committed file. The
record binds the state of the working tree it read, and the gate accepts it only
while that state is unchanged. A range named with `--base` or `--head` is
scanned exactly, without the working tree, so the gate accepts it only while the
working tree is clean. A committed file in the range that the working tree has
changed since is also read as the head commit holds it, so an uncommitted edit
cannot hide a credential the delivery committed. Files are read through the project path-safety boundary:
nothing outside the project root is opened and no symlink is followed.

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
and the validation gate reports an error otherwise. For a story bound to a
workflow instance, the instance's current phase decides whether the story is in
validation. The `--lifecycle-complete` gate requires the same clean record for
the head it certifies, so commits made after validation are scanned too. The flag is read as an
explicit `true`: a project whose configuration never declared it keeps the gate
it agreed to, and adopts the check by initializing from the current template or
migrating through `config migrate`.

Writing the record also appends a `test` trace event carrying the same outcome,
so the run appears in the story history without a separate `trace append`.

## Record a code review of a pull request

`review record` (effect: local) records a review of one pull-request delivery's
diff at the head commit the repository currently holds, as a
`code-review:v1` record under `.sdlc/reviews/`.

```bash
node "$PLUGIN_CLI" review record --root /path/to/project \
  --delivery AUT-PR-BOOKING --verdict approved \
  --actor luca --actor-type human \
  --summary "Diff reviewed against the booking contract"
```

| Input | Purpose |
|---|---|
| `--delivery` | The approved pull-request delivery profile whose diff was reviewed. |
| `--verdict` | `approved` or `changes_requested`. An approval cannot carry a `blocking` finding. |
| `--finding` | One finding as JSON: `severity` (`blocking`, `major`, `minor`, `note`), `summary`, and optional `path` and `line`. Repeat for more. |
| `--actor`, `--actor-type` | The reviewer. |
| `--summary`, `--id` | Optional text and an explicit record ID. |
| `--requirement` | Link the review to the requirements the delivery serves. |

There is no option for the reviewed commit. The command checks out nothing: it
requires the head branch of the delivery to be the current branch, reads its
head and the base tracking ref from the repository, and stores the author
identities of `base..head`. The reviewer's Git name and email come from the
local Git configuration, so a reviewer records from a checkout configured with
their own identity.

A review by an author of the range is recorded, because it happened, and the
output states that it does not satisfy the merge gate.

When `gate_policy.merge_requires_code_review` is `true`, `autonomy delivery
action --action pull_request.merge` exits `1` unless an approved review exists
for the exact head being merged, by a reviewer whose actor and Git email differ
from every commit author of the pull request. Any new commit on the head branch
requires a new review. The flag is read as an explicit `true`: a project whose
configuration never declared it keeps the merge gate it agreed to, and adopts
the check by initializing from the current template or migrating through
`config migrate`.

## Verify the project history

Each history file under `.sdlc/traces` is sealed into a local hash chain with a
checkpoint. Check it at any time:

```bash
node "$PLUGIN_CLI" trace verify
node "$PLUGIN_CLI" trace verify --json
```

The command only reads and checks the top-level history files
(`.sdlc/traces/*.jsonl`). Each file is `valid`, `recoverable`, `unverifiable`,
or `violated`, and the overall `status` is `verified`, `recovery_needed`,
`unverifiable`, or `violated`. It exits `1` only for `violated`: a file that
changed, was truncated, or lost its checkpoint, named with stable error codes.
`doctor` (check `trace-integrity`), `report activity`, and `report query` run the
same full check and lead with a "history changed unexpectedly" warning when it
fails; `status` runs a cheap consistency check. `trace append` refuses to add
to a changed history with the error code `TRACE_INTEGRITY_VIOLATION`.

`recovery_needed` means an earlier recording was interrupted after the event
was written: the next event recorded in that file repairs it automatically, so
do not restore anything. `unverifiable` means the file is above the 64 MiB
verification limit, which is not evidence of tampering.

For `violated`, do not edit history files by hand. If the change was not
intended, back up the history first (restoring discards events recorded since
your last commit), then restore it from version control and verify again:

```bash
cp -R .sdlc/traces .sdlc-traces-backup
git checkout -- .sdlc/traces
node "$PLUGIN_CLI" trace verify
```

This is local tamper evidence, not proof of who wrote the history: someone who
can replace both a trace and its checkpoint can create another consistent pair.

Status and reports read a history file only up to 8 MiB (and 64 MiB across all
history files). `status` and `doctor` (check `trace-size`) warn from 80% of that
limit. Above it, read commands stop with `TRACE_HISTORY_TOO_LARGE`, naming the
file and the limit; see
[the history size limit](how-it-works.md#history-size-limit) for what to do.

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
| `3` | Governance denial: the mutation guard refused to change a governed record or file that the agreed limits or authorization do not cover. | A person decides whether to amend the agreement. Do not retry unchanged. |
| `4` | Environment error: the host cannot run this software as installed. | Repair the installation; `doctor` names the fix. |
| `70` | Internal error: the software failed in a way the caller cannot correct. | Report it with the correlation ID from the output. |

Usage errors include an unknown option, a missing or repeated option value, a
malformed boolean or `--locale`, and an argument given to a command that takes
only options. With `--json` they report the error code `USAGE_ERROR`, while
refusals on the merits report `USER_ERROR`. An unsupported Node.js runtime
reports `UNSUPPORTED_NODE_RUNTIME` with exit code `4`.

A few refusals on the merits report a more specific code, still with exit code
`1`, so automation can react without parsing the message:

| Code | Meaning |
|---|---|
| `CONFIG_MISSING` | `.sdlc/config.json` is missing in an initialized project. Every project command except `trace verify` stops instead of silently using the default privacy rules. The message names the bundled defaults file to copy back when the configuration lock proves the file held only defaults; otherwise restore it from version control. |
| `PROJECT_RECORD_INVALID` | `.sdlc/project.json` is not valid JSON or does not match its schema; restore it from version control. |
| `TRACE_INTEGRITY_VIOLATION` | A history file changed unexpectedly, so nothing was appended; run `trace verify`. |
| `TRACE_HISTORY_TOO_LARGE` | A history file is above the read limit; the message names the file and the limit. |

A command killed by a signal keeps the conventional `128 + signal` form, so a
subprocess interrupted with `SIGINT` exits `130`.

When a project's privacy configuration withholds error details, the exit code
withholds them too: those failures report `1` rather than disclosing through
the exit code the category the message refuses to name.

A check that reaches a negative verdict is a refusal on its merits, not a
governance denial: a blocked `gate check`, a merge-review refusal, and a
secret-scan finding all exit `1`. Only a write stopped by the mutation guard
exits `3`.

```bash
node "$PLUGIN_CLI" gate check --root /path/to/project --scope all --json
case $? in
  0) echo "ready" ;;
  1) echo "blocked; read the failing checks in the output" ;;
  2) echo "fix the invocation" ;;
  3) echo "a governed write was refused; escalate to a person" ;;
  4) echo "repair the installation; run doctor" ;;
  *) echo "report it with the correlation ID" ;;
esac
```

## Open the Change Observatory from a script

`observe --json` prints a machine-readable start record to standard output.
That record includes the local URL **with the per-run access token**. The token
is created for that one run and stops working when the process exits, but while
the process runs it grants read access to the project's lineage. Treat the
output like a password: do not paste it into bug reports, issues, chat, or
shared logs, and do not store it in CI artifacts. When reporting a problem,
share the correlation ID or a support bundle instead, and stop the process with
`SIGINT` or `SIGTERM` when you are done.

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
