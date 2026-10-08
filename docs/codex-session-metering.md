# Native Codex session metering

`codex-session` is the default budget-meter adapter. It reads the
`token_count` events written by Codex to the exact local task JSONL identified
by `CODEX_THREAD_ID` (or explicit `--thread-id`). It does not scrape pages,
call a web API, require authentication, execute a shell, or read prompt and
response bodies.

The adapter is bundled with the plugin and is available after every initial
installation or update. CodeBurn is not required or configured by the standard
path.

## What is measured

Codex supplies cumulative `total_token_usage` counters. The adapter validates:

- `total_tokens = input_tokens + output_tokens`;
- cache-read plus cache-write input does not exceed input;
- counters never regress within the selected task;
- every `token_count` event that carries counters has a valid timestamp and
  non-negative whole-number counters; an invalid event fails the collection
  with `malformed_codex_session_event` instead of being skipped (an event
  without `info` carries only rate-limit context and is ignored);
- the task metadata `cwd` equals the target project;
- the session file remains inside `CODEX_HOME` and is not a symlink;
- baseline and current snapshots keep the same task identity.

The normalized counters are:

| Budget source | Meaning |
|---|---|
| `tokens.total` | Codex `total_tokens`; input plus output, with no cache or reasoning double count |
| `tokens.input` | Non-cached input: input minus cache-read and cache-write input |
| `tokens.output` | Output tokens |
| `tokens.cache_read` | Cached input read |
| `tokens.cache_write` | Cached input written |
| `calls` | Estimated count of cumulative-token advances |

`reasoning_output_tokens` is retained in snapshot evidence but is not added to
`tokens.total`, because Codex already defines the total counter. Sanitized local
rate-limit fields are retained as observation context; they do not widen or
replace the approved project budget.

## Use

Capture the baseline after proposal approval and before apply:

```bash
agentic-sdlc budget meter start \
  --root /path/to/project \
  --proposal ASSESS-001
```

During execution, append the measured delta:

```bash
agentic-sdlc budget meter record \
  --root /path/to/project \
  --proposal ASSESS-001
```

The host normally provides `CODEX_THREAD_ID`. Outside a Codex task, pass the
exact task identifier with `--thread-id`. `--session-file` exists for bounded
tests and recovery; the file must resolve inside `CODEX_HOME`, must not be a
link, and must contain matching `session_meta`.

### When the meter cannot start

| Message | What to do |
|---|---|
| `requires CODEX_THREAD_ID` | Inside a Codex task the host sets it. Outside one, pass `--thread-id <id>`. On a host that does not run Codex tasks there is no session to read: enable the `codeburn` adapter with that host's log provider, or record usage manually with `agentic-sdlc budget usage record --proposal <id> --input-tokens <n> --output-tokens <n>`. |
| `cwd does not match the target project root` | The message names both directories (your home directory is shown as `~`). Meter the task that worked in this project, or pass the `--root` of the project the task used. |
| `adapter '<id>' is disabled` | Set `budget_policy.metering_adapters.<id>.enabled` to `true` in `.sdlc/config.json`, then pin the edit (below). |
| `CodeBurn is not installed or not on PATH` | Install CodeBurn 0.9.x separately or point `budget_policy.metering_adapters.codeburn.command.executable` at it, then pin the edit (below). |

Editing `.sdlc/config.json` by hand does not take effect on its own: the
project keeps using its pinned configuration until you run
`agentic-sdlc config migrate`, review the plan, and apply it with
`agentic-sdlc config migrate --apply --plan-hash <hash>`.

The baseline, snapshots, deltas, and usage receipts are hash-bound and
append-only. Repeating an unchanged observation is idempotent. File truncation,
scope drift, identity drift, malformed target events, or counter resets fail
closed.

## Assurance and limits

The source is local and direct, but it is not provider-signed. Token and call
measurements therefore remain `estimated` with `advisory_observed` assurance;
cost is `unavailable`. `budget meter start` warns about every budget metric
this adapter cannot measure (such as `cost`), and `budget status` shows those
metrics as `not measured` rather than as zero usage. They support warnings and soft limits, but cannot satisfy
an exact hard limit.

RTK and Caveman reduce real context before this meter observes the next
cumulative total. The plugin records that lower measured delta normally. It
never subtracts RTK estimates or assigns synthetic Caveman credit, so the same
budget thresholds, completion reserve, metering violation, and stop rules stay
sovereign.

## Cross-platform boundary

The implementation uses Node.js file APIs and streaming JSONL parsing on
macOS, Linux, and Windows. It accepts LF and CRLF, compares Windows paths
case-insensitively, never invokes a platform shell, and stores project-relative
session paths rather than user-home absolute paths.

CodeBurn remains a disabled legacy adapter for projects that explicitly enable
it. It is never installed or selected by autoconfiguration.
