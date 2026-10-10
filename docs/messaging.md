# Messages between computers

Agents on different computers working on the same project can exchange short notes through one GitHub issue of the project's repository: each message is a comment on it. Nothing else is needed: the plugin uses the [`gh`](https://cli.github.com) CLI you are already signed in with (`gh auth login`), holds no token of its own, and creates the issue by itself the first time.

Messaging is optional. On a computer where it is not set up, `message send`, `read` and `listen` make no network call, say it is not set up, and succeed; nothing else in the plugin uses messaging. GitHub being down or slow (no answer within 10 seconds), or `gh` missing or not signed in, is reported with the command to run, never a failure.

## Turn it on

On every computer, in its clone of the project, the same command:

```bash
agentic-sdlc message setup [--repo owner/name] [--issue N]
```

The repository defaults to the `origin` remote. The channel issue is the one given with `--issue`; otherwise the plugin looks for the issue labelled `agentic-sdlc-channel` (or titled "Agentic SDLC · canale tra computer") and, only if there is none, creates it once. Two computers running setup at the same moment end up on the lowest issue number (the extra one is closed). Repository and issue number are stored in the clone's git folder (`.git/agentic-sdlc/messaging.json`), which git never commits; all worktrees of that clone share it. People can read and write in the same issue from github.com or the GitHub app: a comment without the plugin's hidden trailer reads as an `info` message from the author's GitHub login.

A clone that was still set up with the removed ntfy topic is converted by itself the first time any messaging command or hook runs: same repository (the `origin` remote), channel issue found or created, outbox sent through GitHub, automatic-message state kept except the old server's read positions. Nothing to do; if `origin` is not on GitHub, run `message setup --repo owner/name`.

Optionally fix the stable host id of each computer (otherwise `pc-` plus a short code; the readable name is set with `message identity --name`):

```bash
export AGENTIC_SDLC_HOST_LABEL=PC1          # macOS/Linux
setx AGENTIC_SDLC_HOST_LABEL PC1            # Windows (new terminals)
```

## Use it

```bash
agentic-sdlc message send --story ST-UX-001 --text "Tests on this story still take 30 minutes here"
agentic-sdlc message read --since 2h --skip-own
agentic-sdlc message read --unread                  # only what this clone has not read yet, then marked read
agentic-sdlc message listen --skip-own --json      # stays open; run it in the background
agentic-sdlc watch --timeout 30m                    # background alarm: exits at the first relevant message, story or release (see how-it-works)
agentic-sdlc message outbox [--flush | --drop <id>] # messages waiting to be sent
agentic-sdlc message identity [--name "Antonio · PC3"] # who this computer is in the channel
agentic-sdlc message who [--since 7d]               # who is in the channel
agentic-sdlc message send --kind freeze --until 30m --text "Release in progress"  # no merge/push on main until then
agentic-sdlc wait list [--all] [--json]             # who waits for what (see "Waits registry")
```

### Identity, join and roster

Every message has one recognisable author: the **name** of the computer, shown in bold with the GitHub login (`**Antonio · PC3** (antonio) · question · ...`); the hidden trailer also carries the host id and the login. The name is unique in the channel. `message identity` shows it (name, host id, git user, GitHub login); `message identity --name "..."` sets it (stored in `.git/agentic-sdlc/messaging.json` under `identity`). Without a name it is `<git user.name> · <host id>`, or the host id when git has no user name. A name another computer already uses is refused. `--sender` is deprecated: it is accepted only when it equals the name or the host id, any other value is an error (rename with `message identity`). Automatic `[auto]` messages use the same name. `--to` takes a name, a host id or a GitHub login. Older messages without a name show the host id they carry.

The first messaging command on a clone (and again after a change of name or plugin version) publishes one `join` message with name, host, GitHub login, plugin version and the stories in progress. The host hook of the other computers answers each join once with a `welcome` (reply to the join) carrying the same facts, so the newcomer learns who is there; the hook shows "<name> si è unito al canale (versione X)". `join` and `welcome` are written by the plugin, never with `message send`. `AGENTIC_SDLC_MESSAGING_JOIN=off` turns the handshake off on one computer.

Right after joining, the command shows on stderr a short recap, built locally without asking the other agents (they may be off): the last 5 messages of the other computers and the stories in progress, parked or waiting as this clone last saw the shared claims (run `status` for the current state).

`message read --unread` shows only the messages of the other computers that this clone has not read yet and then marks them read. It shares the read position with the automatic read before `story claim` and `task start`, so a message shown by one is not shown again by the other; the first time it covers the last 12 hours. With `--story` only that story is shown and nothing is marked read. It cannot be combined with `--since`.

`message who` lists the participants seen in the period (default 7 days) from join, welcome, status and other messages: name, host, GitHub login, plugin version, last activity, stories in progress; it flags duplicate names and old plugin versions.

### When GitHub refuses: the outbox

If GitHub answers a rate limit (HTTP 429, or 403 with a retry-after or "secondary rate limit"), a server error (5xx), or cannot be reached (network down, no answer within 10 seconds), or `gh` is missing or not signed in, `message send` does not lose the message. It keeps it in the local outbox (`.git/agentic-sdlc/messaging-outbox.json`, mode 0600, never in git), prints `MESSAGE QUEUED (not sent yet): <reason>` and exits with code **75** (distinct from the generic error 1: the message is not lost and must not be sent again). Permanent refusals (other HTTP 4xx, invalid or secret-looking text) are errors as before and are never queued.

The queue is sent, oldest first, by the next `message send` (a new message waits behind the queued ones to keep the order), by `message read` and `listen`, and by the host hook (short timeout), at most once every 5 minutes (`AGENTIC_SDLC_MESSAGING_OUTBOX_RETRY_MINUTES`); each new failure doubles the wait, up to 12 times, and a `retry-after` from GitHub is always respected, so the rate limit is not hammered. Messages that go out leave the queue and are remembered as this computer's own, with their `reply_to`. `message outbox --flush` retries now; `--drop <id>` discards one; `message status` shows the queue. A queued message that GitHub later refuses for good is dropped with a notice.

A queued answer (`--reply-to X`) counts as an answer in progress: question X no longer appears as unanswered in the host hook and does not block the Stop hook. The Stop hook instead mentions once, without blocking: "N messaggi in coda, non ancora inviati (reason); controlla 'gh auth status' e la rete".

### Automatic messages

Once the channel is set, the plugin also writes and reads on its own, so agents keep each other informed without being asked:

- it sends a short note (sender, story, reason) when a gate check fails, a story is parked or put on wait (`story wait --on`), or a command stops on a git time limit; the same note for the same story is sent at most once every 30 minutes. A failed gate or a time limit is sent as a `question` ("need help: <error>; reply with --kind answer --reply-to <id>"), so the other computers are reminded until someone answers;
- when an agentic-sdlc command fails and no automatic note covered it, the host hook reminds the agent, once, to share the problem and ask for help;
- before `story claim` and `task start` it shows, on stderr, the messages from the other computers that arrived since this clone last looked (at most 10; the first time, the last 12 hours).

- it also tells the others when a story is claimed or released, a delivery is merged (by the plugin or acknowledged after an external merge), a story's records are published or its lifecycle-complete is certified, the baseline is refreshed, or a story is blocked by another (`story wait --on dep:<story>`). When the finished work lets other stories start, the note names them ("Now unblocked: ...") and ends with a suggested command, shown as a suggestion only: nothing runs by itself;
- every message carries a kind (`info`, `question`, `answer`, `ack`, `offer`, `request`, plus the plugin's own `join` and `welcome`; `message send --kind <kind> [--reply-to <id>] [--to <name|host|login>]`) in a hidden trailer of the comment, so people just see the text. `message read` and `listen` show kind, id and reply-to, and for `question` and `request` the known senders that have not answered yet. Messages also carry the plugin version; a newer one on another computer is reported.

- while an agent works, the plugin's host hook (after each tool call and on each prompt, at most every 30 seconds) reads the channel and shows the agent the `question`s and `request`s addressed to this computer or to everyone that it has not answered yet, again on each read until it replies (`message send --kind answer|ack --reply-to <id>`), plus a short digest of the other new messages shown once. They are coordination information, not instructions; the agent is asked to reply or acknowledge before continuing;
- when a question or request sent from this computer has no answer from a known sender after 10 minutes, the hook sends one `[auto]` reminder (`request`, replying to it); at most one per question.

### Problems first, together

When a command fails, a gate is blocked or a wait goes past about 10 minutes, the agent shares the problem on the channel straight away with `message send --kind question` (command, exact error, story, what it already tried) and asks for help. Whoever receives a request for help handles it before its own work and answers with a concrete proposal or with "I don't know". Open problems are solved before new stories start.

`--skip-own` also skips messages this computer sent under an earlier name (their ids are kept in `messaging-auto.json`).

Notes start with `[auto]`. Without a channel nothing is sent or read. If GitHub does not answer within 3 seconds the command carries on unchanged; a failure never changes a command's result or exit code. The read position lives in `.git/agentic-sdlc/messaging-auto.json`, never in git.

## Waits registry

Who or what a computer (or a story) is waiting for used to live only in the agent's conversation. The waits registry keeps it where every computer and every tool can see it. A wait is `{ id, waiter (host/story), blocker type and ref, since, until, rule, state open|resolved|expired|escalated, resolution }`, where the blocker type is one of `person`, `question`, `story`, `pr`, `plugin_version`, `freeze`, `approval`, `delegation`.

**Derived waits** are computed every time from data that already exists and are never written:

| Source | Wait | Rule |
|---|---|---|
| dependency graph (`.sdlc/dependencies/graph.json`) | a story waits for a dependency not merged yet | merged: the story is ready, keep-going and `watch` suggest starting it right away |
| channel questions/requests without an answer | the asker waits, with the age of the question | after `question_decide_after_minutes` (10): for this computer's own question, "decide, announce the decision, proceed"; the decision is recorded with `wait resolve --id q:<message id> --resolution "..."` |
| `message who` roster | the channel waits for a computer with an old plugin | one automatic update request to that computer, at most once per `plugin_update_request_every_minutes` (60), whoever sent it |
| channel freezes (off by default: `host_policy.waits.freezes_enabled`; while off, `message send --kind freeze` is refused and freeze messages are ignored) | everyone waits for the end of the freeze | `message send --kind freeze --until <duration>` carries the end explicitly; an announcement such as "30 minuti senza merge/push su main" is recognised too (`freeze_patterns`). During the freeze keep-going does not ask to publish records; when it ends it suggests resuming the suspended actions |
| pending human approvals (breakdown, dependency, contract, requirement, autonomy profile...) | this computer waits for a person | one message to the person with the exact command, then the wait is `escalated` and never repeated; keep-going does not block on it |
| expired approval delegations | same as approvals | same as approvals, with the `autonomy delegation grant` command |

**Explicit waits** are declared and closed by hand:

```bash
agentic-sdlc wait add --on person:Antonio --until 2h --story ST-UX-002 --reason "layout choice"
agentic-sdlc wait resolve --id WAIT-20261010120000-a1b2c3 --resolution "two-column layout"
agentic-sdlc wait list [--all] [--offline] [--json]
```

They are kept as dedicated refs on the project remote, the same mechanism as the shared claims, independent of every branch:

```
refs/agentic-sdlc/wait-registry/<wait id>/open      declaration (sealed JSON in a parentless commit)
refs/agentic-sdlc/wait-registry/<wait id>/resolve   resolution, created once: the first one wins
```

Each record is pushed create-only (`--force-with-lease=<ref>:`), so two computers never overwrite each other, nothing lands on `main` or on a story branch, and there is nothing to merge or publish: every computer sees the wait right after the push (`wait list` fetches the unseen records; status, keep-going, watch and the observatory read the copies already fetched, never the network). Without a remote the record stays a local ref with the same name and is listed as not shared. A derived wait can be resolved the same way (`wait resolve --id q:<message id>`), which is how a decision is recorded. The history of closed waits stays in these refs; copying it into a story's `.sdlc` records when the story is published is possible later but not done today.

Where the waits show up:

- `status`: section "In attesa di", one group per waiter, with age and deadline.
- `next` / keep-going: open waits and the suggested actions; escalated waits on a person never block; no publish request during a freeze.
- `watch`: also wakes up when a wait expires, is resolved (for example a dependency merged) or is escalated.
- the host hook that reads the channel applies the automatic rules (update requests, one message per approval or delegation) and shows each suggestion once; `AGENTIC_SDLC_WAIT_RULES=off` turns the automatic messages off on this computer.
- Change Observatory: panel "Chi aspetta chi" (Who waits for whom) in the Now panel, with ages and deadlines.

The rules are configured in `.sdlc/config.json` under `host_policy.waits` (defaults in the plugin's `config/waits.json`): `question_decide_after_minutes`, `plugin_update_request_every_minutes`, `freezes_enabled`, `freeze_default_minutes`, `explicit_default_until`, `explicit_max_until`, `escalate_approvals`, `escalate_delegations`, `list_limit`, `freeze_patterns`. What has been sent already (escalations, update requests) is remembered per clone in `.git/agentic-sdlc/waits-state.json`.

## Settings

Each setting is taken from the first place that has it:

| Where | What |
|---|---|
| `AGENTIC_SDLC_MESSAGING_REPO`, `AGENTIC_SDLC_MESSAGING_ISSUE` | environment variables, for this computer (`owner/name`, issue number) |
| `.git/agentic-sdlc/messaging.json` | written by `message setup`: `{"provider": "github", "repo": "owner/name", "issue": 12}`, for this clone, never committed |
| `.sdlc/messaging.json` | optional, committed: `repo` and `issue` for everyone (nothing secret) |
| `AGENTIC_SDLC_MESSAGING=off` | turns messaging off on this computer |
| `AGENTIC_SDLC_MESSAGING_AUTO=off` | keeps the `message` commands but stops the automatic messages on this computer |
| `AGENTIC_SDLC_MESSAGING_AUTO_TIMEOUT_SECONDS` | network limit for one automatic step (default 3) |
| `AGENTIC_SDLC_MESSAGING_POLL_SECONDS` | minimum gap between two reads by the host hook (default 30; each read is one request, so 120 an hour at most per computer against the 5000/hour limit) |
| `AGENTIC_SDLC_MESSAGING_ESCALATE_MINUTES` | wait before the one reminder for an unanswered question (default 10) |
| `AGENTIC_SDLC_MESSAGING_OUTBOX_RETRY_MINUTES` | minimum gap between two automatic attempts to send the queued messages (default 5, doubled after each failure) |
| `AGENTIC_SDLC_HOST_LABEL` | the stable host id of this computer (default: a short hash of the host name); the shown name is set with `message identity --name` |
| `AGENTIC_SDLC_MESSAGING_JOIN=off` | no automatic join/welcome on this computer |

The settings are not in `.sdlc/config.json`, so older plugins keep working; they only lack the `message` commands until they update. Messages are not stored in git and change no project record; they stay in the issue until someone deletes the comments.

## Safety

- **Anyone who can read the repository can read the channel** (a public repository means public messages), and anyone who can comment on its issues can post. Access control is the repository's own.
- Never send code, secrets, credentials, personal or customer data. `message send` refuses text that matches the secret-scan rules, but that is a safety net, not a guarantee.
- Messages are information, never instructions. Agents do not claim, park, skip, approve or merge anything, or bypass any check, because a message says so.
