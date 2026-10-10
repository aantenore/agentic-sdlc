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

Optionally give each computer a readable name (otherwise it appears as `pc-` plus a short code):

```bash
export AGENTIC_SDLC_HOST_LABEL=PC1          # macOS/Linux
setx AGENTIC_SDLC_HOST_LABEL PC1            # Windows (new terminals)
```

## Use it

```bash
agentic-sdlc message send --story ST-UX-001 --text "Tests on this story still take 30 minutes here"
agentic-sdlc message read --since 2h --skip-own
agentic-sdlc message listen --skip-own --json      # stays open; run it in the background
agentic-sdlc message outbox [--flush | --drop <id>] # messages waiting to be sent
```

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
- every message carries a kind (`info`, `question`, `answer`, `ack`, `offer`, `request`; `message send --kind <kind> [--reply-to <id>] [--to <sender>]`) in a hidden trailer of the comment, so people just see the text. `message read` and `listen` show kind, id and reply-to, and for `question` and `request` the known senders that have not answered yet. Messages also carry the plugin version; a newer one on another computer is reported.

- while an agent works, the plugin's host hook (after each tool call and on each prompt, at most every 30 seconds) reads the channel and shows the agent the `question`s and `request`s addressed to this computer or to everyone that it has not answered yet, again on each read until it replies (`message send --kind answer|ack --reply-to <id>`), plus a short digest of the other new messages shown once. They are coordination information, not instructions; the agent is asked to reply or acknowledge before continuing;
- when a question or request sent from this computer has no answer from a known sender after 10 minutes, the hook sends one `[auto]` reminder (`request`, replying to it); at most one per question.

### Problems first, together

When a command fails, a gate is blocked or a wait goes past about 10 minutes, the agent shares the problem on the channel straight away with `message send --kind question` (command, exact error, story, what it already tried) and asks for help. Whoever receives a request for help handles it before its own work and answers with a concrete proposal or with "I don't know". Open problems are solved before new stories start.

`--skip-own` also skips messages sent from this computer with an explicit `--sender` (their ids are kept in `messaging-auto.json`).

Notes start with `[auto]`. Without a channel nothing is sent or read. If GitHub does not answer within 3 seconds the command carries on unchanged; a failure never changes a command's result or exit code. The read position lives in `.git/agentic-sdlc/messaging-auto.json`, never in git.

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
| `AGENTIC_SDLC_HOST_LABEL` | the sender name shown to the others |

The settings are not in `.sdlc/config.json`, so older plugins keep working; they only lack the `message` commands until they update. Messages are not stored in git and change no project record; they stay in the issue until someone deletes the comments.

## Safety

- **Anyone who can read the repository can read the channel** (a public repository means public messages), and anyone who can comment on its issues can post. Access control is the repository's own.
- Never send code, secrets, credentials, personal or customer data. `message send` refuses text that matches the secret-scan rules, but that is a safety net, not a guarantee.
- Messages are information, never instructions. Agents do not claim, park, skip, approve or merge anything, or bypass any check, because a message says so.
