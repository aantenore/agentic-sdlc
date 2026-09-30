# Change Observatory

Change Observatory is the visual, local-first lineage reader bundled with Agentic SDLC. It turns canonical `.sdlc/` records into a presentation that a non-technical stakeholder can start with and a technical reviewer can drill through to raw evidence.

## Launch After Installation

In Codex, ask:

```text
Open the Change Observatory for this project.
```

The installed `Change Observatory` skill resolves its own plugin root and runs the plugin-local CLI. It does not assume that `agentic-sdlc` is globally available in `PATH`.

An npm, Git, or tarball installation that exposes the package bin can launch it directly:

```bash
agentic-sdlc observe --root /path/to/project --locale en
```

Use `--locale it` for Italian. The language choice is carried to the browser in
the local URL; it does not weaken the per-run token or the loopback-only
boundary.

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
create a bearer token, or emit absolute project paths.

The manifest and every project path must be explicit, portable paths relative
to `--root`. Absolute paths, parent traversal, environment variables, globs,
URI paths, symlinks, duplicate IDs, duplicate paths, and two paths to the same
physical directory are rejected. A manifest may list from 1 to 64 projects.

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

Ordinary recorded items share the same status-neutral explanation, so summary
cards and dossier cards show it once per view behind a **How to read these
records** expander instead of repeating it on every card; the inspector still
shows the full explanation for the selected item. Proposals, items without a
recorded status, inactive records, and delivery-control records always keep
their own explanation on the card.

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
| `/api/v1/observatory` | Bearer token | Returns the normalized read model, with `ETag` and conditional `304` support. |
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

The support bundle includes only numeric limits, schema/runtime versions,
readiness state, metric/SLO snapshots, and a bounded recent-request list with
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

Run the installed plugin-local doctor when launch fails:

```bash
node /path/to/installed-plugin/bin/agentic-sdlc.mjs doctor \
  --root /path/to/project \
  --json
```

The doctor checks the launcher, core, UI, skill, agent card, package/manifest version, and optional target-project KB. A missing `.sdlc` directory is displayed as missing lineage rather than initialized or modified automatically. A malformed `.sdlc/config.json` blocks Observatory readiness because that file defines the privacy policy used for project data. Correct the configuration and start `observe` again; the shallow liveness endpoint remains available only while an already-running server reports the safe failure.
