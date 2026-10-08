---
name: agentic-sdlc-assessment
description: Contextualize an existing software project and deliver an initial technical, functional, architecture, or product assessment through a proposal-bound Agentic SDLC workflow. Use for natural requests in any language such as "contextualize this project", "contestualizza questo progetto e prepara un assessment", "assess the architecture and project health", or requests for a verified assessment artifact in Markdown, Word, Excel, PDF, PowerPoint, HTML, JSON, or CSV.
---

# Agentic SDLC Assessment

## Operating Contract

Load `../agentic-sdlc/SKILL.md` for shared CLI, KB, contract, trace, and gate rules. Use this skill as the assessment product choreography. `<plugin-root>` is exactly two directories above this `SKILL.md`, the same directory the shared skill resolves.

The normal journey has exactly two logical user checkpoints:

1. inferred project context;
2. one immutable combined assessment proposal.

Do not expose baseline, requirement, story, capability, template, contract, route, authorization, task start, budget accounting, or receipt records as separate normal questions. If a fresh approved baseline exists, checkpoint 1 may be a concise reaffirmation, but it must still let the user correct the context when contextualization was requested.

Ask an additional decision only for a material exception: an install, external access, secret, production access, destructive action, out-of-scope write, material proposal change, or budget extension not already bounded by the approved proposal. An exception is not a normal checkpoint.

Use `<target-project>/.sdlc/config.json` `assessment_workflow.requested_actions` to decide which normalized route actions enter this journey. Do not hardcode a second alias list. For every open question, classify it with `open_question_guidance.categories`; show the original question, configured reason, an example in the active language (`it` first for Italian, `en` as fallback), and `effect_of_answer`. Use the configured fallback when no category matches.

Treat `<target-project>/.sdlc/` as canonical. Treat cache and indexes as derived. Repository application files are read-only until checkpoint 2 approves a displayed write; pre-approval writes are limited to proposed `.sdlc/` workflow records.

## Question Contract

Every user-facing question, including a clarification or exception, must say in the user's language:

- **What is being asked**;
- **Why it is needed now**;
- **What the answer authorizes**;
- **What it does not authorize**;
- **Examples of valid answers in Italian and English**.

Do not ask a bare yes/no question. Persist direct human or CI decisions as a host-issued receipt conforming to `schemas/host-approval-receipt.schema.json`; an agent must not self-declare a human approval.

## Enter The Journey

1. Resolve the target root from the request, otherwise use the workspace root. If it cannot be identified, ask one clarification using the Question Contract.
2. Capture format, destination, evidence boundary, exclusions, autonomy, and budget already stated. Do not ask for known values again.
3. Initialize or onboard the existing project. Prefer `onboard existing-project` when repository evidence exists so inferred context remains proposed.
4. Reserve stable IDs for the requirement, story, proposal, workflow, budget, template, contract, authorization, and receipts. Reservation is not creation or approval of those subjects.
5. Inspect repository files, canonical `.sdlc/` evidence, and user-provided local files read-only. External sources require an explicit displayed boundary.
6. Normalize the request to canonical route intent. Use `technical_analysis` with `technical-analysis` for technical, architecture, or combined assessments; use `functional_analysis` with `functional-analysis` for primarily functional assessments.

Do not produce assessment findings before both checkpoints are approved.

## Checkpoint 1: Inferred Project Context

Present a decision-ready summary in the user's language with:

- product purpose, users, and lifecycle stage supported by evidence;
- stack, runtime, deployment model, integrations, boundaries, and key components;
- files, directories, and documents inspected;
- constraints and explicit non-goals;
- observed facts separated from inference;
- assumptions, contradictions, confidence, open questions, and unrecoverable historical intent.

Paths support the explanation; they do not replace it.

End with this complete question contract, translated when appropriate:

- **What is being asked:** approve or correct the project context just shown.
- **Why:** the assessment needs a canonical factual baseline and must not treat inference as confirmed intent.
- **Authorizes:** only making the displayed baseline content canonical.
- **Does not authorize:** assessment scope, requirement/story creation, format, tools, external access, writes, budget, contract, or execution start.
- **Question:** “Do you approve this context, or what should I correct?”
- **Italian examples:** “Approvo il contesto”; “Correggi: il deployment è su Kubernetes, non su ECS.”
- **English examples:** “I approve the context”; “Correct this: deployment is Kubernetes, not ECS.”

Apply corrections and repeat the same checkpoint until the represented baseline is safe. Persist the decision only with `baseline approve` and its host approval receipt. Do not reuse checkpoint 1 as authorization for checkpoint 2.

## Prepare The Immutable Proposal

After checkpoint 1:

1. Inspect the output registry and choose `reuse`, `delta`, or `new`. Prefer an approved related artifact plus a delta when it satisfies the request.
2. For a new technical assessment, load `<plugin-root>/templates/technical-assessment.md`. Preserve every semantic section, marking unsupported content `Not evidenced` or `Not assessed`.
3. Resolve or reserve a real requirement and story. The story must link to the requirement; never use a project-only placeholder or a fabricated requirement ID.
4. Profile installed capabilities and exact targets from evidence. Do not ask the user what is installed: run `capability inventory --json` (read-only; the names, one-line descriptions, and transport types of the skills, commands, plugins, and MCP servers already installed for the user and the project, with no values, no secrets, and no network call) and use `capability recommend --from-inventory` to propose only the installed entries whose name or description names a technology declared by the approved evidence. Missing installs or risky targets must be visible in checkpoint 2 or handled as an exception; the allowed capabilities are shown inside checkpoint 2, not as a separate question.
5. Resolve the complete execution budget from project configuration and runtime metering. Aggregate the main agent and all subagents at story scope.
6. Run `assessment proposal prepare`. Persist an `assessment_proposal` with `schema_version: assessment-proposal:v1` and a `proposal_hash` over the approval payload.

The proposal must bind the approved baseline hash and contain concrete values for:

- `scope` and `story_reservation`, including the requirement ID;
- `deliverable`, ordered sections, canonical delivery metadata, generator, and verifier;
- exact evidence plan and capability bindings;
- `contract_draft` and canonical `route_intent`;
- `write_set[]` with action, exact subject ID, path, subject hash when known, and artifact types;
- `execution_budget`;
- security and access boundaries;
- approval boundary and idempotent application plan.

No approval may authorize a record constructed after the question. If any approved payload field changes, generate a new proposal hash and present the revised checkpoint 2.

## Checkpoint 2: Combined Proposal And Full Tranche

Present one proposal with five primary business blocks and a compact technical appendix.

1. **Outcome, scope, and evidence**: decision supported, audience, included/excluded areas, depth, requirement/story reservation, reuse mode, exact sources, and local checks.
2. **Deliverable and verification**: ordered sections, format, extension, media type, path, delivery mode, generator, verifier, and required container/content/render dimensions.
3. **Tools, security, and writes**: installed capabilities, permissions, targets, commands/checks, full write-set, and risky actions excluded.
4. **Budget and stop policy**: approved execution tranche, described below.
5. **Start and approval boundary**: exact internal records/actions, authorized task start, delivery behavior, exception triggers, and explicit exclusions.

The technical appendix must show at least the proposal ID/hash, baseline hash, requirement/story IDs, template/contract IDs and hashes, authorization actions, artifact types, and idempotency key. Technical details may be collapsible, but they must be visible before approval.

### Budget Block

Show concrete values and the source/accuracy for each enabled metric:

- target active execution time; user and approved external waiting are excluded. The configured default is an estimated soft limit of 2,700 seconds with no hard limit;
- aggregate steps across the execution tree. The configured default is an estimated soft limit of 40 with no hard limit;
- aggregate tokens across the execution tree. The configured default is an estimated soft threshold of 200,000 and has no hard limit;
- cost cap and currency only with a named, reliable metering/pricing adapter, pricing reference, and currency;
- warning thresholds, normally 70% and 90% from configuration;
- completion/verification reserve, normally 15% from configuration;
- action at the limit: always `request_extension`; at the pause the person extends (`budget amend`), takes a partial result, or stops (`assessment proposal cancel`);
- whether any bounded automatic extension exists. Default is none.

Use `exact`, `estimated`, or `unavailable` honestly. Never present an estimated or unavailable metric as a hard enforced cap. If a reliable metering/pricing adapter, pricing reference, or currency is missing, explicitly show cost as `unavailable` and non-binding in checkpoint 2; do not construct a default cost limit. The approved tranche includes analysis, subagents, artifact generation, verification, KB linking, gate checks, and final delivery; do not spend the completion reserve on optional analysis.

End with this complete question contract, translated when appropriate:

- **What is being asked:** approve this exact proposal hash and its complete execution tranche, or request changes.
- **Why:** one decision can safely cover all represented internal records and start actions only when their content, tools, writes, verification, and budget are fixed in advance.
- **Authorizes:** creation/reuse of the displayed requirement and story; only the displayed subject hashes and write-set; proposal-bound automation approvals; authorized task start; the displayed analysis, artifact generation, layered verification, KB linking, budget policy, and final summary.
- **Does not authorize:** installs, undisplayed external/production access, secrets, destructive work, other paths or subjects, a different artifact, material proposal changes, or budget extensions not explicitly bounded in the proposal.
- **Question:** “Do you approve proposal `<id>` with hash `<hash>`, including this budget and stop policy, or what should I change?”
- **Italian examples:** “Approvo la proposta `<id>` con questo budget”; “Modifica: massimo 45 minuti, niente fonti esterne, output DOCX.”
- **English examples:** “I approve proposal `<id>` with this budget”; “Change it: 45 minutes maximum, no external sources, DOCX output.”

One response decides the entire visible bundle. Do not ask separate normal questions for requirement, story, format, tools, template, contract, authorization, budget, or start.

## Approve And Apply Without A Third Checkpoint

After checkpoint 2 approval:

1. Run `assessment proposal approve`. It must validate the unchanged proposal hash, persist the checkpoint 2 host receipt, and create a proposal-bound `content_authorization` with exact actions, subjects, subject hashes, artifact types, boundaries, and a bounded use policy.
2. Run `assessment proposal apply`. Apply the displayed write-set idempotently: create/reuse the requirement, create/reuse the story, persist capability records, template, story contract, budget, and approvals. A partial failure must remain resumable through workflow state; do not create a second proposal.
3. Use `requirement create|status` for requirement lineage. Reuse only an exact matching requirement; never invent a free-text ID only to satisfy a gate.
4. Every automated approval or task-start use must validate authorization at the use timestamp and persist an `authorization_usage_receipt`. Later closure or revocation must not invalidate valid historical receipts.
5. Start only the displayed story, unchanged contract, route intent, and proposal. A direct `actor-type human` flag without a host receipt is not a valid bypass.
6. Monitor with `assessment proposal status`, `budget status`, and non-blocking progress updates. Record usage with `budget usage record`.
7. Close or consume the authorization when the workflow reaches a terminal state.

Use `assessment proposal complete` only after required delivery, verification, linkage, usage receipts, and deterministic gates pass. Apply and complete are internal actions, not normal user decisions.

## Budget Exceptions And Amendments

At warning thresholds, report usage and remaining verification reserve without asking a question. Before exceeding a non-automatic limit, pause with one exception question using the Question Contract. Show:

- remaining budget and metering accuracy;
- completed and remaining work;
- requested increment and new total;
- reason and partial-delivery alternative;
- what the extension authorizes and excludes.

Italian examples: “Approvo altri 20 minuti, totale 60”; “Consegna parziale senza estensione.” English examples: “Approve 20 more minutes, 60 total”; “Deliver the partial result without an extension.”

Persist an approved change with `budget amend` as `budget_amendment:v1` referencing the base budget and proposal hashes. Never mutate the approved base budget. An extension does not widen scope, capabilities, access, or write paths.

## Canonical Formats

| Format | Aliases | Extension | Media type | Generator/verifier |
| --- | --- | --- | --- | --- |
| `markdown` | `md`, `markdown` | `.md` | `text/markdown` | native checks |
| `docx` | `word`, `doc`, `docx` | `.docx` | `application/vnd.openxmlformats-officedocument.wordprocessingml.document` | `documents` |
| `xlsx` | `excel`, `spreadsheet`, `workbook`, `xlsx` | `.xlsx` | `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` | `spreadsheets` |
| `pdf` | `pdf` | `.pdf` | `application/pdf` | `pdf` |
| `pptx` | `powerpoint`, `slides`, `pptx` | `.pptx` | `application/vnd.openxmlformats-officedocument.presentationml.presentation` | `presentations` |
| `html` | `html` | `.html` | `text/html` | native generation plus browser rendering |
| `json` | `json` | `.json` | `application/json` | native schema/syntax checks |
| `csv` | `csv` | `.csv` | `text/csv` | `spreadsheets` |

Use `artifact` or `artifact-plus-chat-summary`; default to the latter. Never rename Markdown to fake another format.

## Generate, Verify, And Link

Load the corresponding format skill before generating or validating a non-native artifact. If it is unavailable, request the install as an exception; do not improvise a substitute.

The generator must emit an `artifact_generator_receipt` containing the generator identity, artifact path/hash, executor, and generation time. Pass it separately from render evidence:

```bash
node <plugin-root>/bin/agentic-sdlc.mjs output link \
  --root <target-project> \
  --story ST-INITIAL-ASSESSMENT \
  --type technical-analysis \
  --artifact docs/technical-assessment.docx \
  --template technical-analysis-v1 \
  --mode new \
  --requirement REQ-INITIAL-ASSESSMENT \
  --authorization <authorization-id-from-assessment-proposal-approve> \
  --receipt-file .sdlc/receipts/generation/GEN-ST-INITIAL-ASSESSMENT.json \
  --render-evidence .sdlc/tests/ST-INITIAL-ASSESSMENT-docx-render.png
```

`--authorization` is the exact proposal-bound ID returned by approval; linking consumes only its `output.link` action/subject pair and persists a use receipt. `--receipt-file` proves which capability generated the real artifact. `--render-evidence` supplies only the separate render or visual proof; functional and test evidence belongs in `story complete-step` or `trace append`. The older `--evidence` spelling remains a compatibility alias for this render-only input; neither form can substitute for the generator receipt.

Persist a layered `verification_receipt:v1` with distinct dimensions:

- `container_verified`: file/container syntax and declared format;
- `content_verified`: required sections, stable IDs, evidence lineage, and semantic checks;
- `render_verified`: legibility, completeness, overlap/clipping, pages/sheets/slides/viewports;
- optional `independent_verified`: a genuinely separate verifier or review.

Call an artifact “verified” only when every dimension required by the approved proposal passes. Otherwise say exactly “container verified”, “content verified”, or “render not verified”. A legacy `status: passed` container receipt alone means only structural verification.

## Complete The Workflow

After approval, finish without a routine third checkpoint:

1. produce only the approved artifact and write-set;
2. persist generator, layered verification, authorization-use, and execution-usage receipts;
3. link requirement, story, contract, proposal, artifact, and evidence hashes;
4. run applicable deterministic and strict gates;
5. create the release manifest and release-gate receipt when the result is released; use `archive-record:v1` only for logical legacy exclusions, and use the separate transactional `archive_plan` policy only when files must actually move;
6. return a concise verdict, major risks, recommendations, artifact path, exact verification dimensions, budget actuals with accuracy/source, limitations, and open decisions.

The user may request revisions after delivery. Request an exception decision only when continuing would cross the approved proposal or budget boundary.

For an existing KB, run `migration active --release-manifest <released-id>` without `--apply` before migration. Explain that the manifest defines what stays active, give the exact apply command as the example, and state the effect: missing config defaults may be added, immutable active records are only validated, and evidence from older valid releases is logically archived while remaining in place.
