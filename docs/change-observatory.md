# Change Observatory

Change Observatory is the visual, local-first lineage reader bundled with Agentic SDLC. It turns canonical `.sdlc/` records into a presentation that a non-technical stakeholder can start with and a technical reviewer can drill through to raw evidence.

## Your First Time

Change Observatory is a small web page that runs on your own computer and only
reads your project's recorded history. It never changes a file and sends
nothing anywhere. This is what to expect the first time.

1. **Start it.** Ask your agent to open the Change Observatory for this project,
   or run the command yourself (see below). If your agent offers plugin
   commands, `/agentic-sdlc:observe` does the same thing; agents that work
   through skills start it from a plain request such as
   `Open the Change Observatory for this project.`
2. **Keep the terminal open.** The page is served by the command that is
   running in your terminal. While it runs the page works; closing the
   terminal, or pressing **Ctrl+C**, stops it and the page stops working.
3. **Open the full link.** The terminal prints one link after *Next step*. Open
   that whole link, including the long part after the `#` sign. That part is a
   one-time access key for this run; without it the page shows "This page is not
   allowed to read the local observatory" (HTTP 401). If you see that message,
   copy the full link from the terminal again. The key is kept only for the
   current browser tab (session storage), so a **new tab or window needs the
   full link again**.
4. **Press Refresh to see new records, or turn on Live updates.** By default the
   page does not update by itself: after your agent records something new, use
   the **Refresh** button at the top. **Live updates** re-reads the records
   every 30 seconds while the tab is visible, without losing your place.
5. **Find your way around.** Each view answers one question:

   | View | What it is for |
   | --- | --- |
   | Overview | A dashboard that opens with one sentence (for example "9 of 27 stories delivered"), a progress bar split by status, and the stories moving right now. Below it: activity over time (by hour, day, or week depending on the history), check results, and the latest activity. Every tile, bar, and status opens the matching filtered view. |
   | Stories | Every piece of work as one row with its six steps and its ID; a pulsing dot means it was worked on in the last few hours. Search, filter by status, sort, and open a row to see what it needs first, what it unlocks, its activity, and links to the map, timeline, or dossier. |
   | Timeline | Everything that was recorded, newest first and grouped by day. Search, filter by type or story, and click a bar of the activity chart to focus on one period. Selecting an entry shows its evidence. |
   | Map | When `.sdlc/dependencies/graph.json` exists, the map opens on the **project plan**: every story in waves from left to right, with a line from each story to the work it unlocks. Selecting a story lights up its whole chain. **One story in detail** shows the lineage of one story from the request to the checks; related records are drawn for the selected box only. |
   | Story dossier | Each piece of work step by step, from the request to verification, plus the phase-by-phase lineage matrix. Old `#timeline` links open this view. |
   | Contracts | The agreed boundaries and how they changed over time. |
   | Decisions | Choices that were made, with the reasons and the alternatives that were rejected. |
   | Changes | What was actually changed, grouped by the intent behind it. |
   | Intent evidence | Optional, content-free notes about what an agent was asked to do. It is empty unless that recording is turned on, and an empty view is normal. |
   | Verification | The checks and gates that were run, and what they showed. |

   The visual views only read the recorded history. A story's state comes from
   its recorded steps (in progress, blocked, started, delivered, not started, or
   stopped). The steps are the phases of the software-project workflow,
   operations included. A story with an active claim is in progress; a story
   that has not started and depends on work that is not delivered yet is
   shown as waiting; a story closed with `story supersede` is shown as
   replaced, with a link to the story that took over. These are the same
   rules `status` uses, so the counts match. The charts are drawn in the page itself
   without any external library or network request. Evidence warnings and raw
   record controls stay on the detailed record views, so the everyday views
   remain uncluttered. The warnings banner appears only for problems a reader
   can act on (for example a record that cannot be read) and starts closed;
   routine notes from normal plugin use, such as links to contracts, plain-text
   evidence, or older records without a schema version, stay in its technical
   details. Titles and summaries that contain record IDs, paths, or commands
   keep their readable words; only the technical fragment is removed.

6. **If something goes wrong.** A port that is already in use is reported with
   the suggestion to use `--port 0`. `--host` accepts only `127.0.0.1`; other
   addresses are refused on purpose so that the page is never reachable from
   another computer. If the project settings file (`.sdlc/config.json`) is
   changed while the page is running, the page asks you to stop the command
   (Ctrl+C) and start it again; refreshing the page will not help.

## Launch After Installation

Ask your agent:

```text
Open the Change Observatory for this project.
```

The installed `Change Observatory` skill resolves its own plugin root and runs the plugin-local CLI. It does not assume that `agentic-sdlc` is globally available in `PATH`.

An npm, Git, or tarball installation that exposes the package bin can launch it directly:

```bash
agentic-sdlc observe --root /path/to/project --locale en
```

Use `--locale it` for Italian. Without `--locale`, the observatory follows the
`locale` recorded in `.sdlc/project.json` when the project was initialized with
`init --locale <en|it>`, and falls back to English otherwise. The language
choice is carried to the browser in the local URL; it does not weaken the
per-run token or the loopback-only boundary.

## Open An Explicit Project Portfolio

To compare several local projects, create one JSON manifest inside their common
parent folder. The list is explicit: Change Observatory does not scan sibling
folders, infer projects, or fall back to a different file.

For this layout:

```text
/work/
  portfolio.json
  booking-service/
  payment-service/
```

`/work/portfolio.json` can contain:

```json
{
  "schema_version": "portfolio-manifest:v1",
  "projects": [
    { "id": "booking", "path": "booking-service" },
    { "id": "payments", "path": "payment-service" }
  ]
}
```

Launch only that list:

```bash
agentic-sdlc observe \
  --root /work \
  --portfolio-manifest portfolio.json
```

For CI or a quick terminal check, use the one-shot read-only command instead:

```bash
agentic-sdlc portfolio status \
  --root /work \
  --manifest portfolio.json \
  --json
```

It prints compact status JSON and exits. It does not start an HTTP server,
create a bearer token, or emit absolute project paths. Without `--json` it
prints one line per project; every project that is not ready also shows a short
plain reason, for example `gone: unavailable (This project's folder was not
found. Check its path in the portfolio file.)`.

By default the command only reports and exits `0`. Add `--fail-on-attention`
to use it as a gate: it then exits `1` when any project is unavailable or needs
attention, and `0` when every project is ready or only needs review. The JSON
output carries `fail_on_attention` and, for each project, an `attention_reason`
(`null` when the project is fine).

Naming the family alone, `agentic-sdlc portfolio`, shows the help for that
family instead of an error.

The manifest and every project path must be explicit, portable paths relative
to `--root`. Absolute paths, parent traversal, environment variables, globs,
URI paths, symlinks, duplicate IDs, duplicate paths, and two paths to the same
physical directory are rejected. A manifest may list from 1 to 64 projects.
Write every path with forward slashes (`/`), also on Windows. Each error names
the project (by its position and id) and quotes the value that was refused, so
`Project #2 (id "win"): the path "projects\\beta" is not allowed: it must be a
relative path written with forward slashes (/)` points straight at the line to
fix. A value that would reveal a location on your computer (an absolute path,
a home folder, a drive letter, a variable, or a URL) is described instead of
repeated, for example `(an absolute path; value not shown)`, so these messages
are safe to paste into a ticket. A missing manifest file is reported with the
path that was looked up.

A project whose folder does not exist does not stop the portfolio: it appears
as an unavailable card ("This project's folder was not found") while the other
projects stay usable, in the same way as a folder that has no `.sdlc` records.

The first screen reads bounded summaries only. Summary collection is a separate
projection and never builds a project's full Observatory model. It reads only
the canonical project, requirement, story/workflow, risk, budget, dependency,
release, and gate-report locations needed for the cards. Per project it reads
at most 256 files, 64 KiB per file, and 2 MiB in total, and retains at most
1,024 parsed summary records and eight preview items per aggregate. The versioned
`change-observatory:portfolio-aggregates:v1` projection reports active
workflows, blockers, risks, budgets, dependencies, and releases. Blockers,
failed releases, exceeded budgets, malformed summary evidence, and unresolved
risks determine the displayed project and portfolio health rather than a
generic count alone.

Choose a project to load its detailed lineage; choosing **All projects** returns to the portfolio summary.
If one project cannot be read safely, its card explains that it is unavailable
while the other projects remain usable. Raw evidence links stay bound to the
selected manifest project. Without `--portfolio-manifest`, the existing
single-project view is unchanged.

The selected project is represented by one validated `project` parameter in
the local browser URL. This makes a project view reloadable and lets browser
Back and Forward restore the previous portfolio selection. Missing, duplicated,
malformed, or unknown project IDs fall back to **All projects**; they are never
used to construct a project or source path. While a different project is
loading, the prior model, selection, diagnostics, inspector, and raw-source
links are cleared immediately, so changing views cannot relabel one project's
evidence as another project's evidence.

The page exposes one contextual heading and named content region. Its heading
and skip-link label distinguish the portfolio overview from the selected
project and follow the requested English or Italian locale.

For a reader who does not know the plugin, every delivery-control record starts
with five practical answers: what happened, what changes in practice, whether a
decision is needed, what remains protected, and what to do next. Exact policy
names, identifiers, and stored reason codes appear only after the optional
**Technical details** divider or in the explicit raw-evidence drawer.

In italiano: ogni decisione viene prima spiegata come risultato, impatto,
decisione richiesta, protezioni ancora attive e prossimo passo. Livelli, codici
e identificativi interni restano nei **Dettagli tecnici** facoltativi.

Ordinary project records share the same explanation for each kind of recorded
state, so summary and dossier cards explain each kind once per view behind a
**How to read these records** expander instead of repeating it on every card.
A proposal, an item without a recorded status, or an inactive record still shows
its one-line warning on the card itself; delivery-control records keep their
full explanation, and the inspector always shows the full explanation for the
selected item.

Automation can suppress browser opening and consume the first NDJSON event:

```bash
agentic-sdlc observe \
  --root /path/to/project \
  --host 127.0.0.1 \
  --port 0 \
  --no-open \
  --json
```

`observatory.ready.url` is the browser URL. Keep the process alive while using the application and stop it with `SIGINT` or `SIGTERM`.

## Operational Checks And Diagnostics

There are two different meanings of “healthy”. **Live** means the local process
is answering HTTP requests. **Ready** means it has also rechecked the project
and UI boundaries and can build the current read model. A damaged or temporarily
changing `.sdlc` tree may therefore leave `/live` at `200` while `/ready`
returns `503`; this is intentional and makes the failure diagnosable without
pretending the evidence is usable. Startup performs the readiness warm-up
before announcing `observatory.ready`. In portfolio mode that warm-up builds
only the lightweight summary. The four-worker collection ceiling is validated
before the server binds, so an invalid concurrency setting cannot produce a
false-ready process.

All routes accept only `GET` and `HEAD` and are available only on the loopback
server. “Bearer token” below means the random per-run token that the browser
reads from the URL fragment and keeps in session memory.

| Endpoint | Authentication | What it answers |
| --- | --- | --- |
| `/api/v1/live` | None | Is the local HTTP process answering? This check does not read project evidence. |
| `/api/v1/health` | None | Compatibility alias for the same shallow liveness check. |
| `/api/v1/ready` | Bearer token | Can the pinned project/UI boundaries and current canonical read model be validated now? Returns `503` when not ready. |
| `/api/v1/observatory` | Bearer token | Returns the normalized read model, with `ETag` and conditional `304` support. Clients that send `Accept-Encoding: gzip` (every browser) receive it compressed, usually at a tenth of its size or less. |
| `/api/v1/source?path=...` | Bearer token | Returns one allowed, bounded, presentation-redacted source record. |
| `/api/v1/portfolio` | Bearer token | In explicit portfolio mode, returns the bounded manifest-order summary without project paths or raw-source references. |
| `/api/v1/portfolio/project?project=...` | Bearer token | Lazily returns one selected project view from the loaded manifest. |
| `/api/v1/portfolio/source?project=...&path=...` | Bearer token | Returns one bounded source record scoped to the selected manifest project. |
| `/api/v1/metrics` | Bearer token | Returns the current process-local metric snapshot. |
| `/api/v1/slo` | Bearer token | Evaluates advisory availability and readiness objectives over samples from this process. |
| `/api/v1/support-bundle` | Bearer token | Returns allowlisted, redacted diagnostic sections plus a content-integrity digest. |

Each request receives an `X-Correlation-ID` response header in the form
`corr-<uuid>`. A caller may send an existing valid ID in the request header;
invalid values fail with a stable `400` response. Error bodies contain a safe
code, message, retryability flag, and correlation ID. They do not expose a
stack trace, project root, token, secret, or raw exception detail.

Metrics live only in memory for the lifetime of this server process. Their
labels are selected from fixed route, status, cache-event, and readiness values;
project paths, story IDs, messages, and correlation IDs are not metric labels.
This closed cardinality keeps both memory use and diagnostic shape bounded.
The SLO endpoint is advisory: the default availability and readiness targets
are `0.99`, with `20` samples required before it reports `met` or `breached`.
It does not block a delivery or claim provider-grade monitoring.

The support bundle includes only numeric limits, schema and runtime versions
(the Agentic SDLC package version, Node.js version, platform, and CPU
architecture, but no host name or path), readiness state, metric/SLO snapshots, and a bounded recent-request list with
time, correlation ID, route, safe code, and status. Redaction is applied before
the bundle is returned. Its SHA-256 digest covers the canonical **redacted**
payload, so it can reveal later content changes without retaining a fingerprint
of removed secret bytes. The digest is not a signature, origin proof, or
authenticity claim.

## What It Shows

- the recorded request and requirement behind an iteration;
- a proof-bound dossier for each story, ordered as Asked, Decided, Contract,
  Done, and Verified;
- what changed, grouped by recorded intent where available;
- decisions, approvals, rationale summaries, alternatives, and evidence;
- standing approvals with their status, deliveries used and left, expiry, whether the trusted host signed the approval, each delivery that ran under one, and the cost recorded against a cost budget;
- each delivery's lead time (proposed, approved, work started, first action, released or ready for review), the time it waited for a person, and the cost and tokens recorded against it, or "not measured". These figures are shown as recorded: a meter's figure is labelled as not verified here, because only the CLI verifies meter evidence and signatures before any decision relies on a cost;
- how independently the current delivery may proceed, whether a review is now
  needed, and which sensitive actions remain protected; exact internal settings
  and recorded reason codes stay in technical details;
- immutable delivery start/close state and exact action authorization/completion receipts, without treating an authorization as proof that the action ran;
- contract evolution and implementation/validation/release state;
- tests, gates, handoffs, sync events, and missing or malformed lineage;
- content-free IntentABI Codex shadow observations, when explicitly linked to a story trace;
- raw canonical JSON, JSONL, Markdown, and text evidence under `.sdlc/`.

The working agreement is presented as a practical answer, not as policy
vocabulary. A reader first sees what may be completed for this delivery, which
sensitive action still requires a review, and that the choice expires with this
delivery. Internal level and authority codes remain available only in technical
details and the raw-evidence drawer.

### Everyday Views, Search, And Large Projects

The sidebar shows four everyday views: Overview, Stories, Timeline, and Map.
The record-level views (requests, agreements, decisions, changes, checks, agent
notes, and the step-by-step story record) sit under **More details**, which
stays open once chosen.

- **Work on other computers.** Stories claimed on the shared remote appear as
  in progress, with who holds them. The Observatory reads only the local copies
  that `status` and the claim commands keep (`GET /api/v1/claims`); it never
  contacts the remote. A delivered story that a change request is changing
  says so ("Being changed by ...").
- **Stories not pulled yet.** Stories another computer recorded on the shared
  base branch, but missing from this copy, are listed as "New on another
  computer" (`GET /api/v1/remote-stories`). They are read from the
  remote-tracking branch that `status` fetches; nothing is fetched or changed
  by the Observatory.
- **Search** ignores accents, case, and ID punctuation (`st replan 001` finds
  `ST-REPLAN-001`), ranks ID and title matches first, and highlights matches.
- **Large projects.** Lists render a page at a time with **Show more**. A plan
  with more than 120 stories hides finished work that unlocks nothing still
  open, with **Show everything** to bring it back. Dependency edges come from
  a compact endpoint (`GET /api/v1/dependencies`), so a large
  `dependencies/graph.json` never hides the plan. The knowledge base is read
  stories, requirements, contracts, dependencies, and traces first, so when a
  project outgrows the read limits (8,192 files, 64 MiB by default) the
  stories still appear and a warning names what was skipped.

The interface uses `recorded`, `inferred`, `missing`, and `malformed` provenance explicitly. It never silently turns an absent record into a completed phase.

## Proof-Bound Iteration Dossiers

The global lists remain useful for portfolio-level inspection, but they are not
the causal lineage of one iteration. Each recorded story therefore has an
additive dossier that groups its evidence into five lanes:

1. **Asked** — the story, explicitly linked requirements, and recorded request;
2. **Decided** — the agreed working limit, the choice made specifically for the
   current delivery, approvals, assumptions, risks, and their stored rationale
   or alternatives; internal policy records remain available as technical
   evidence;
3. **Contract** — the exact story contract and any contract-bound approval;
4. **Done** — implementation, delivery-action completion, and sync evidence recorded for the story;
5. **Verified** — tests, gates, completed steps, local smoke receipts, remote host/provider evidence when present, and release evidence.

A lane membership is allowed only when canonical evidence records an explicit
`story_id`, `requirement_id`, `related` identifier, contract identifier, or
evidence path that resolves to the story. Time proximity, filename similarity,
display titles, and free-text semantics are never lineage signals. The server
computes the dossier once; the server serializes it only in the top-level
`dossiers` collection, and the browser associates it to an iteration only when
their exact story IDs match. The browser then validates and renders that bounded
projection and does not attempt a second semantic join.

When no iteration is selected, the dossier opens on the most relevant story:
the most recent story with lineage in progress, otherwise the most recently
delivered one (release phase complete or a delivered status). Stories recorded
as superseded, cancelled, or abandoned are chosen only when nothing else exists.

An autonomy record belongs to a story dossier only through its explicit story,
contract, requirement-profile, or delivery-profile reference. The Observatory
must not infer that a choice for one PR also applies to another PR or local
release.

An empty lane is shown as `missing`, not inferred from another story or from the
Git history. Records that cannot be bound explicitly stay visible in the global
views and diagnostics instead of being attached to the nearest iteration. This
also means a repository can honestly show project-level operational evidence
without pretending that an unrecorded historical story existed.

## Intent Evidence

The optional Intent evidence view reads the IntentABI Codex envelope schema
`io.github.aantenore.intentabi/authenticated-codex-shadow-evidence/v1alpha1`
from canonical files under `.sdlc/observations/intentabi/`. It is an additive
read model: these observations never become requests, changes, decisions,
contracts, phase completions, or verification results.

Each observation must use the exact lowercase path
`.sdlc/observations/intentabi/<event-id>.json`, where `<event-id>` is the same
UUID v4 stored in the envelope. Nested paths, descriptive filenames, mismatched
IDs, and JSONL batches are omitted so filenames cannot become a side channel.

An observation is linked to a story only when a canonical trace lists the exact
observation path in its top-level `evidence` array and records a non-empty
`story_id`. Without both records it remains explicitly `unlinked`; timestamps,
filenames, and nearby iterations are never used to infer lineage.

The application displays only the event ID, shadow mode, submitted input choice,
preparation outcome and reason, proof-presence state, and `MAC present / not
verified`. It does not load IntentABI key material or derive the trusted binding,
so it cannot verify the MAC. Candidate observation is not presented as semantic
equivalence, a cache hit, authorization to reuse, token savings, or permission to
submit transformed content. The original input remains the submitted input in
this v1alpha1 contract.

The parser accepts the exact upstream envelope shape and projects only those
display fields. Unknown or additional fields, including raw prompt, candidate,
or output content, make the entry malformed and cause its content to be omitted
from both the normalized model and the source drawer. The source drawer returns
the same safe projection rather than the full envelope and omits file-level
hash and size metadata for this evidence class.

The three overview answers use an injectable semantic-ranking policy rather than recency alone: implementation evidence ranks ahead of operational sync events for “What changed?”, while approvals, recorded rationale, and alternatives rank ahead of task-start bookkeeping for “Why was it decided?”. Equivalent diagnostics are grouped by fingerprint in both the server model and browser client; non-error diagnostics stay collapsed so lineage remains visible, while errors open automatically.

## Explainability Without Private Reasoning

`trace append` can store a shareable narrative with repeatable input/output summaries, a rationale summary, alternatives, and an optional explanation:

```bash
agentic-sdlc trace append \
  --root /path/to/project \
  --story ST-001 \
  --type implementation \
  --summary "Added the local lineage launcher" \
  --input-summary "Approved implementation contract" \
  --output-summary "Installed observe command" \
  --rationale-summary "Keep project evidence local and reproducible" \
  --alternative "Hosted dashboard" \
  --explanation "The installed plugin can now open the recorded delivery lineage." \
  --explanation-kind codex-generated
```

The stored explanation scope is always `recorded-evidence-only`. Valid kinds are `codex-generated`, `deterministic`, and `human-authored`; the UI presents all three under the neutral “Plain-language explanation” label and preserves the authoring badge. A recorded `rationale_summary` remains a distinct “Recorded rationale” field rather than being collapsed into that generated explanation. Private chain-of-thought, internal reasoning traces, and equivalent fields are not part of the narrative contract; if legacy or malformed evidence declares them, the observatory fails closed and redacts the affected surface.

## Security And Privacy Boundary

- The server binds only to `127.0.0.1`; non-loopback hosts are rejected.
- Every run creates a random capability token. It travels in the URL fragment, is held in browser session memory, and is sent as a bearer token only to the same-origin evidence APIs.
- The project root and bundled UI directory identities are pinned for the run. Root replacement and symlink swaps are rejected.
- `.sdlc` must be a real directory, not a symlink. Symlink components, cache/index paths, traversal, unsupported extensions, oversized responses, and malformed structured raw content fail closed.
- Only `GET` and `HEAD` are accepted. Responses use no-store caching, same-origin resource policy, a restrictive CSP, and no CORS permission.
- The application and server do not write to the target project.

Before a trace is persisted, the operational redactor removes values under
sensitive keys, known token formats, bearer values, configured secret/PII
patterns, email addresses, credential assignments, and private-key blocks.
Before any normalized or raw-source surface is displayed, presentation
redaction runs again. If its configured bounds are exceeded, the affected
content is withheld instead of being shown unredacted.

Long random-looking text is not a secret merely because of its entropy. A value
is redacted when it has a known credential form or context, is explicitly
configured as sensitive, or matches a configured secret/PII pattern. This is
why a normal receipt ID such as
`AUT-ACT-20260718113959949-d28fa8` is retained as an audit reference rather than
misclassified as a secret. Projects may add detector patterns and identifier
allow patterns in `.sdlc/config.json`; unsafe or ambiguous regular expressions
are rejected. Custom repetition must have an explicit maximum of 256 characters;
email is already covered by the bounded built-in detector. An identifier allow
pattern should be as narrow as its contract and can never disable a known
credential detector or an explicit privacy rule.

The server keeps one serialized read model for the current canonical revision. Concurrent requests share one rebuild, and subsequent requests receive a strong `ETag`; an unchanged conditional `GET` or `HEAD` returns `304` without serializing or transferring the model again. Before every reuse, the server rechecks the project boundary and a deterministic, bounded snapshot of canonical source content. Changes during a rebuild cause a retry rather than publishing a mixed revision. Derived cache and index directories never participate in the revision.

The model is compressed once per revision for clients that accept gzip; the
`ETag` and the decoded JSON are the same either way. In italiano: il modello
viene compresso una sola volta per revisione e il browser lo riceve più
leggero, senza cambiare né l'`ETag` né il contenuto.

Portfolio project runtimes use an access-ordered LRU with eight cached projects
by default and no more than four concurrent summary reads. Evicted runtimes
clear their full-model caches, and server shutdown disposes every remaining or
in-flight runtime. Cache hits, misses, evictions, clears, and disposal are
reported through the existing closed-cardinality local cache metric. Filesystem
device and inode identities remain exact bigint values throughout capture and
comparison, including Windows file IDs larger than JavaScript's safe integer
range.

The browser keeps only the matching model and `ETag` in memory. It sends
`If-None-Match` on refresh and reuses that exact model after `304`. It does not
persist the model to local storage, and a `304` without a matching in-memory
model is treated as an error rather than an instruction to display stale or
unknown data.

The same configured limits bound revision scanning and normalization: aggregate
directory entries, file count, individual file bytes, aggregate bytes, depth,
and record collection size. A directory that would cross the entry budget is
skipped as one unit and reported, so the result never depends on whichever
filename happened to be read first. The loopback server scans up to the
configured record budget but materializes at most 1,000 entries in each visual
collection by default; an embedding API may choose another explicit bound.
Oversized or unreadable evidence is represented by a stable diagnostic boundary
instead of causing an unbounded read. The deterministic enterprise benchmark
verifies warm-response p95 and RSS budgets on the full canonical workload.

The token protects against unrelated local processes guessing the random port. It is an ephemeral local capability, not a multi-user identity or remote-access system. Do not publish the URL, tunnel the port, or bind it to another interface.

The project-local `observability` configuration controls additional redaction
patterns, readiness/SLO thresholds, and the recent-request bound. The shipped
policy fixes metric cardinality and keeps both top-level and metric
`external_sinks` disabled. There is no background exporter, hosted collector,
or telemetry upload in this implementation.

The privacy configuration is pinned when Change Observatory starts. It is
checked again before and after every project-data read. If `.sdlc/config.json`
is added, removed, changed, made invalid, or replaced by a symlink while the
server is running, liveness stays available but readiness and project-data
routes stop. Restart Change Observatory to review and apply the new settings;
the existing process never mixes evidence produced under two privacy policies.

## Troubleshooting

| What you see | What it means and what to do |
| --- | --- |
| The page says it is not allowed to read the local observatory (HTTP 401) | The page was opened without its access key. Open the full link printed in the terminal, including the part after `#`. A new tab needs the full link again. |
| The page asks you to stop and start the command again | `.sdlc/config.json` changed while the page was running. Press Ctrl+C in the terminal, run `observe` again, and open the new link. |
| The page says it lost its connection | The terminal that runs the observatory was closed or stopped. Start it again and open the new full link. |
| "Port N on 127.0.0.1 is already in use" | Another program uses that port. Choose another with `--port <number>` or use `--port 0` for any free port. |
| "Records are changing right now" | Something is writing to `.sdlc` continuously. The observatory already retried a few times; wait a few seconds and press **Refresh**. |
| "No Agentic SDLC records were found in this folder" | The folder you opened has no `.sdlc` folder. Ask your agent to initialize Agentic SDLC, or run `agentic-sdlc init` in the project folder, then press **Refresh**. If it is the wrong folder, restart with `--root`. |
| An error says `.sdlc/config.json is not valid JSON` or that `.sdlc` is a symbolic link | The error names the file and the kind of problem without printing its contents. Fix or restore the file, or replace the link with a real folder, then run the command again. |
| The browser did not open | The terminal prints the full link again; copy it into your browser. Use `--no-open` to skip the attempt. |

If you pipe the output (for example `observe --json | head -1`) and the reader
closes early, the observatory stops cleanly instead of failing.

Run the installed plugin-local doctor when launch fails:

```bash
node /path/to/installed-plugin/bin/agentic-sdlc.mjs doctor \
  --root /path/to/project \
  --json
```

The doctor checks the launcher, core, UI, skill, agent card, package/manifest version, and optional target-project KB. A missing `.sdlc` directory is displayed as missing lineage rather than initialized or modified automatically. A malformed `.sdlc/config.json` blocks Observatory readiness because that file defines the privacy policy used for project data. Correct the configuration and start `observe` again; the shallow liveness endpoint remains available only while an already-running server reports the safe failure.
