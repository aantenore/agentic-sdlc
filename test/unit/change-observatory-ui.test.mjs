import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  ObservatoryApi,
  ObservatoryApiError,
  accessTokenFromHash,
} from "../../ui/change-observatory/api.js";
import {
  DOSSIER_LANES,
  DOSSIER_SCHEMA,
  PHASES,
  VIEW_MODEL_SCHEMA,
  filterIterations,
  groupChangesByIntent,
  isCanonicalEvidencePath,
  iterationRelevance,
  narrativeFor,
  normalizeDossier,
  normalizeViewModel,
  preferredDossierIteration,
  rawHrefForPath,
  rawTargetFor,
  recordSelectionKey,
  safeRawHref,
} from "../../ui/change-observatory/model.js";
import { parsePreviewPort } from "../helpers/change-observatory-preview-server.mjs";

const UI_ROOT = new URL("../../ui/change-observatory/", import.meta.url);
const INTENTABI_EVENT_ID = "123e4567-e89b-42d3-a456-426614174000";
const INTENTABI_PATH = `.sdlc/observations/intentabi/${INTENTABI_EVENT_ID}.json`;

function viewModel(overrides = {}) {
  return {
    schemaVersion: VIEW_MODEL_SCHEMA,
    generatedAt: "2026-07-16T09:00:00.000Z",
    project: { id: "fixture-project", name: "Fixture Project", branch: "codex/fixture" },
    snapshots: { counts: { stories: 1 }, phaseCounts: { implementation: 1 } },
    summary: {
      asked: [
        {
          id: "REQ-FIXTURE",
          type: "requirement",
          title: "Fixture request",
          summary: "A recorded test-only request.",
          status: "proposed",
          phase: "discovery",
          provenance: "recorded",
          sourceRefs: [{ path: ".sdlc/requirements/REQ-FIXTURE.json" }],
        },
      ],
      changed: [],
      decided: [],
    },
    iterations: [
      {
        id: "ITERATION-FIXTURE",
        type: "iteration",
        title: "Iteration fixture",
        summary: "Test-only iteration.",
        status: "active",
        provenance: "recorded",
        currentPhase: "implementation",
        sourceRefs: [{ path: ".sdlc/stories/ST-FIXTURE/story.json" }],
        phases: [
          { phase: "discovery", status: "complete", provenance: "recorded", sourceRefs: [] },
          {
            phase: "implementation",
            status: "inProgress",
            provenance: "recorded",
            sourceRefs: [{ path: ".sdlc/stories/ST-FIXTURE/story.json" }],
          },
        ],
      },
    ],
    contracts: [],
    decisions: [],
    changes: [],
    verification: [],
    records: [
      {
        path: ".sdlc/requirements/REQ-FIXTURE.json",
        kind: "requirement",
        provenance: "recorded",
        rawHref: "/api/v1/source?path=.sdlc%2Frequirements%2FREQ-FIXTURE.json",
      },
    ],
    diagnostics: [],
    ...overrides,
  };
}

function semanticObservation(overrides = {}) {
  return {
    id: INTENTABI_EVENT_ID,
    type: "intentabi-codex-shadow",
    title: "Equivalent cached request",
    summary: "Saved 42 tokens",
    status: "recorded",
    provenance: "recorded",
    sourceRefs: [{ path: INTENTABI_PATH }],
    rawHref: `/api/v1/source?path=${encodeURIComponent(INTENTABI_PATH)}`,
    mode: "shadow",
    submitted: "original",
    outcome: "candidate-observed",
    reason: "CANDIDATE_ATTESTED",
    proof: "present-unverified",
    macStatus: "present-not-verified",
    keyId: "forbidden-key-id",
    inputKind: "forbidden-input-kind",
    bindingDigest: "forbidden-binding-digest",
    equivalence: true,
    cacheHit: true,
    tokenSavings: 42,
    link: {
      status: "linked",
      storyId: "ST-FIXTURE",
      traceIds: ["TRACE-FIXTURE"],
      sourceRefs: [{ path: ".sdlc/traces/TRACE-FIXTURE.json", pointer: "/evidence/0" }],
    },
    ...overrides,
  };
}

function iterationDossier(overrides = {}) {
  const linkedItem = (id, type, title, extra = {}) => ({
    id,
    type,
    title,
    summary: `${title} summary.`,
    status: "recorded",
    provenance: "recorded",
    storyId: "ITERATION-FIXTURE",
    sourceRefs: [{ path: `.sdlc/evidence/${id}.json` }],
    linkage: {
      status: "linked",
      storyId: "ITERATION-FIXTURE",
      via: ["story_id"],
      sourceRefs: [{ path: `.sdlc/evidence/${id}.json` }],
    },
    ...extra,
  });

  return {
    schemaVersion: DOSSIER_SCHEMA,
    storyId: "ITERATION-FIXTURE",
    iterationId: "ITERATION-FIXTURE",
    status: "partial",
    provenance: "recorded",
    sourceRefs: [{ path: ".sdlc/stories/ITERATION-FIXTURE/story.json" }],
    links: { requirementIds: ["REQ-FIXTURE"], contractIds: ["CONTRACT-FIXTURE"] },
    lanes: {
      asked: {
        status: "recorded",
        provenance: "recorded",
        items: [linkedItem("REQ-FIXTURE", "requirement", "Recorded request")],
      },
      decided: {
        status: "recorded",
        provenance: "recorded",
        items: [linkedItem("DEC-FIXTURE", "decision", "Recorded decision", {
          narrative: {
            rationaleSummary: "Recorded rationale stays authoritative.",
            generatedExplanation: "Generated explanation stays visibly separate.",
            explanationSource: "codex-generated",
            provenance: "recorded",
          },
        })],
      },
      contract: {
        status: "recorded",
        provenance: "recorded",
        items: [linkedItem("CONTRACT-FIXTURE", "contract", "Governing contract")],
      },
      done: {
        status: "recorded",
        provenance: "recorded",
        items: [linkedItem("CHANGE-FIXTURE", "implementation", "Implemented change")],
      },
      verified: { status: "missing", provenance: "missing", items: [] },
      release: {
        status: "recorded",
        provenance: "recorded",
        items: [linkedItem("RELEASE-FIXTURE", "release", "Product release")],
      },
    },
    diagnostics: [],
    ...overrides,
  };
}

test("normalizes the versioned view model and makes absent phases explicit", () => {
  const model = normalizeViewModel(viewModel());

  assert.equal(model.schemaVersion, VIEW_MODEL_SCHEMA);
  assert.equal(model.project.name, "Fixture Project");
  assert.deepEqual(model.iterations[0].phases.map((phase) => phase.phase), PHASES);
  assert.equal(model.iterations[0].phases[0].status, "complete");
  assert.equal(model.iterations[0].phases[3].status, "inProgress");
  assert.equal(model.iterations[0].phases[5].status, "missing");
  assert.deepEqual(model.changes, []);
  assert.deepEqual(model.semanticObservations, []);
});

test("normalizes an inline proof-bound dossier without collapsing rationale into explanation", () => {
  const payload = viewModel();
  payload.iterations[0].dossier = iterationDossier();
  const model = normalizeViewModel(payload);

  assert.deepEqual(DOSSIER_LANES.map((lane) => lane.label), [
    "Asked",
    "Decided",
    "Contract",
    "Done",
    "Verified",
  ]);
  assert.equal(model.iterations[0].dossier.schemaSupported, true);
  assert.equal(model.dossiers.length, 1);
  assert.equal(model.iterations[0].dossier.status, "partial");
  assert.equal(model.iterations[0].dossier.lanes.verified.status, "missing");
  assert.equal(model.iterations[0].dossier.lanes.release.items[0].type, "release");

  const decision = model.iterations[0].dossier.lanes.decided.items[0];
  const narrative = narrativeFor(decision);
  assert.equal(narrative.rationale, "Recorded rationale stays authoritative.");
  assert.equal(narrative.generatedExplanation, "Generated explanation stays visibly separate.");
  assert.notEqual(narrative.rationale, narrative.generatedExplanation);
  assert.equal(narrative.explanationLabel, "codex-generated");
  assert.equal(decision.linkage.status, "linked");
  assert.deepEqual(decision.linkage.via, ["story_id"]);
});

test("attaches top-level dossiers only through an exact explicit story ID", () => {
  const payload = viewModel({
    dossiers: [
      iterationDossier(),
      iterationDossier({ storyId: "ST-UNLINKED", iterationId: "ST-UNLINKED" }),
    ],
    unlinked: [{
      id: "PROJECT-ONLY",
      type: "decision",
      title: "Project-level record",
      provenance: "recorded",
      sourceRefs: [{ path: ".sdlc/decisions/PROJECT-ONLY.json" }],
    }],
  });
  const model = normalizeViewModel(payload);

  assert.equal(model.iterations[0].dossier.storyId, "ITERATION-FIXTURE");
  assert.equal(model.dossiers.length, 2);
  assert.equal(model.dossiers[1].storyId, "ST-UNLINKED");
  assert.equal(model.unlinkedLineage.length, 1);
  assert.equal(model.unlinkedLineage[0].id, "PROJECT-ONLY");
});

test("rejects ST-B dossier and item ownership when rendering iteration ST-A", () => {
  const iterationA = { ...viewModel().iterations[0], id: "ST-A", title: "Story A" };
  const foreignDossier = iterationDossier({
    storyId: "ST-B",
    iterationId: "ST-B",
    sourceRefs: [{ path: ".sdlc/stories/ST-B/story.json" }],
  });

  const topLevel = normalizeViewModel(viewModel({
    iterations: [iterationA],
    dossiers: [foreignDossier],
  }));
  assert.equal(topLevel.iterations[0].dossier, null);
  assert.ok(topLevel.diagnostics.some((entry) => entry.code === "dossier_iteration_not_found"));

  const inline = normalizeViewModel(viewModel({
    iterations: [{ ...iterationA, dossier: foreignDossier }],
  }));
  assert.equal(inline.iterations[0].dossier, null);
  assert.ok(inline.diagnostics.some(
    (entry) => entry.code === "dossier_iteration_ownership_mismatch",
  ));

  const crossStoryItem = {
    id: "REQ-ST-B",
    type: "requirement",
    title: "Story B request",
    provenance: "recorded",
    storyId: "ST-B",
    sourceRefs: [{ path: ".sdlc/requirements/REQ-ST-B.json" }],
    linkage: {
      status: "linked",
      storyId: "ST-B",
      via: ["story_id"],
      sourceRefs: [{ path: ".sdlc/requirements/REQ-ST-B.json", pointer: "/story_id" }],
    },
  };
  const ownedDossier = iterationDossier({
    storyId: "ST-A",
    iterationId: "ST-A",
    lanes: {
      asked: { status: "recorded", provenance: "recorded", items: [crossStoryItem] },
    },
  });
  const itemMismatch = normalizeViewModel(viewModel({
    iterations: [{ ...iterationA, dossier: ownedDossier }],
  }));
  assert.equal(itemMismatch.iterations[0].dossier.lanes.asked.status, "malformed");
  assert.equal(itemMismatch.iterations[0].dossier.lanes.asked.provenance, "malformed");
  assert.deepEqual(itemMismatch.iterations[0].dossier.lanes.asked.items, []);
  assert.equal(itemMismatch.iterations[0].dossier.status, "malformed");
  assert.ok(itemMismatch.iterations[0].dossier.diagnostics.some(
    (entry) => entry.code === "dossier_item_ownership_mismatch",
  ));
});

test("derives coherent lane and dossier states from accepted canonical items", () => {
  const fixture = iterationDossier();
  const ownedItem = fixture.lanes.asked.items[0];

  const recordedEmpty = normalizeDossier(iterationDossier({
    status: "complete",
    lanes: {
      asked: { status: "recorded", provenance: "recorded", items: [] },
    },
  }));
  assert.equal(recordedEmpty.lanes.asked.status, "malformed");
  assert.equal(recordedEmpty.lanes.asked.provenance, "malformed");
  assert.equal(recordedEmpty.status, "malformed");
  assert.ok(recordedEmpty.diagnostics.some(
    (entry) => entry.code === "dossier_lane_state_inconsistent",
  ));

  const missingWithItems = normalizeDossier(iterationDossier({
    status: "complete",
    lanes: {
      asked: { status: "missing", provenance: "missing", items: [ownedItem] },
    },
  }));
  assert.equal(missingWithItems.lanes.asked.status, "malformed");
  assert.equal(missingWithItems.lanes.asked.provenance, "malformed");
  assert.equal(missingWithItems.status, "malformed");

  const releaseDoesNotComplete = normalizeDossier(iterationDossier({ status: "complete" }));
  assert.equal(releaseDoesNotComplete.lanes.release.status, "recorded");
  assert.equal(releaseDoesNotComplete.lanes.verified.status, "missing");
  assert.equal(releaseDoesNotComplete.status, "partial");

  const completeFixture = iterationDossier();
  const fullyRecorded = normalizeDossier({
    ...completeFixture,
    status: "partial",
    lanes: {
      ...completeFixture.lanes,
      verified: {
        status: "recorded",
        provenance: "recorded",
        items: [completeFixture.lanes.release.items[0]],
      },
    },
  });
  assert.equal(fullyRecorded.status, "complete");
  assert.deepEqual(
    DOSSIER_LANES.map(({ key }) => fullyRecorded.lanes[key].status),
    ["recorded", "recorded", "recorded", "recorded", "recorded"],
  );
});

test("keeps a top-level recorded rationale object separate from generated explanation", () => {
  const dossier = normalizeDossier(iterationDossier({
    lanes: {
      decided: {
        status: "recorded",
        provenance: "recorded",
        items: [{
          id: "DEC-SEPARATE",
          type: "decision",
          title: "Separate narrative fields",
          provenance: "recorded",
          storyId: "ITERATION-FIXTURE",
          sourceRefs: [{ path: ".sdlc/decisions/DEC-SEPARATE.json" }],
          linkage: {
            status: "linked",
            storyId: "ITERATION-FIXTURE",
            via: ["story_id"],
            sourceRefs: [{ path: ".sdlc/decisions/DEC-SEPARATE.json", pointer: "/story_id" }],
          },
          rationale: {
            text: "This is the recorded rationale.",
            provenance: "recorded",
            sourceRefs: [{ path: ".sdlc/decisions/DEC-SEPARATE.json", pointer: "/narrative/rationale_summary" }],
          },
          explanation: {
            text: "This is the generated explanation.",
            authoring: "codex-generated",
            provenance: "recorded",
          },
        }],
      },
    },
  }));
  const narrative = narrativeFor(dossier.lanes.decided.items[0]);

  assert.equal(narrative.rationale, "This is the recorded rationale.");
  assert.equal(narrative.generatedExplanation, "This is the generated explanation.");
  assert.notEqual(narrative.rationale, narrative.generatedExplanation);
});

test("dossier normalization is fail-closed for provenance, linkage, and raw sources", () => {
  const dossier = normalizeDossier(iterationDossier({
    schemaVersion: "change-observatory:iteration-dossier:future",
    lanes: {
      asked: {
        items: [
          {
            id: "REQ-UNSAFE",
            title: "Unsafe source",
            rawHref: "https://example.com/secret",
            provenance: "claimed",
            storyId: "ITERATION-FIXTURE",
            linkage: {
              status: "linked",
              storyId: "ITERATION-FIXTURE",
              via: ["story_id"],
            },
            sourceRefs: [{ path: ".sdlc/requirements/REQ-UNSAFE.json" }],
          },
          {
            id: "REQ-CROSS-STORY",
            title: "Cross-story source",
            storyId: "ST-OTHER",
            linkage: { status: "linked", storyId: "ST-OTHER", via: ["story_id"] },
            sourceRefs: [{ path: ".sdlc/requirements/REQ-CROSS-STORY.json" }],
          },
        ],
      },
    },
  }));

  assert.equal(dossier.schemaSupported, false);
  assert.equal(dossier.lanes.asked.provenance, "malformed");
  assert.equal(dossier.lanes.asked.items.length, 1);
  assert.equal(dossier.lanes.asked.items[0].rawHref, null);
  assert.deepEqual(dossier.lanes.asked.items[0].linkage, {
    status: "linked",
    storyId: "ITERATION-FIXTURE",
    via: ["story_id"],
    sourceRefs: [],
  });
  assert.equal(dossier.diagnostics.at(-1).code, "dossier_item_ownership_mismatch");
  for (const lane of ["decided", "contract", "done", "verified", "release"]) {
    assert.equal(dossier.lanes[lane].status, "missing");
    assert.deepEqual(dossier.lanes[lane].items, []);
  }
});

test("redacted source paths never produce raw UI targets", () => {
  const redactedPath = ".sdlc/requirements/[REDACTED].json";
  const model = normalizeViewModel(viewModel({
    summary: {
      asked: [{
        id: "REQ-REDACTED",
        type: "requirement",
        title: "Redacted source",
        summary: "The source location is intentionally unavailable.",
        provenance: "recorded",
        sourceRefs: [{ path: redactedPath, rawAvailable: false }],
        rawHref: null,
        rawAvailable: false,
      }],
      changed: [],
      decided: [],
    },
    records: [{
      path: redactedPath,
      kind: "requirement",
      provenance: "recorded",
      rawHref: null,
      rawAvailable: false,
    }],
  }));
  const item = model.summary.asked[0];
  const record = model.records[0];

  assert.equal(item.rawHref, null);
  assert.equal(item.rawAvailable, false);
  assert.equal(item.sourceRefs[0].rawAvailable, false);
  assert.equal(record.rawHref, null);
  assert.equal(record.rawAvailable, false);
  assert.equal(isCanonicalEvidencePath(redactedPath), false);
  assert.equal(rawHrefForPath(redactedPath), null);
  assert.equal(rawTargetFor(item), null);
});

test("projects valid IntentABI evidence onto the closed content-free UI contract", () => {
  const model = normalizeViewModel(viewModel({
    semanticObservations: [semanticObservation()],
  }));

  assert.equal(model.semanticObservations.length, 1);
  const observation = model.semanticObservations[0];
  assert.deepEqual(Object.keys(observation).sort(), [
    "id",
    "link",
    "macStatus",
    "mode",
    "outcome",
    "proof",
    "provenance",
    "rawHref",
    "reason",
    "sourceRefs",
    "submitted",
    "type",
  ]);
  assert.equal(observation.id, "123e4567-e89b-42d3-a456-426614174000");
  assert.equal(observation.mode, "shadow");
  assert.equal(observation.submitted, "original");
  assert.equal(observation.outcome, "candidate-observed");
  assert.equal(observation.reason, "CANDIDATE_ATTESTED");
  assert.equal(observation.proof, "present-unverified");
  assert.equal(observation.macStatus, "present-not-verified");
  assert.equal(
    observation.rawHref,
    `/api/v1/source?path=${encodeURIComponent(INTENTABI_PATH)}`,
  );
  assert.deepEqual(observation.link, {
    status: "linked",
    storyId: "ST-FIXTURE",
    traceIds: ["TRACE-FIXTURE"],
    sourceRefs: [{ path: ".sdlc/traces/TRACE-FIXTURE.json", pointer: "/evidence/0" }],
  });

  const projected = JSON.stringify(observation);
  for (const forbidden of [
    "Equivalent cached request",
    "Saved 42 tokens",
    "forbidden-key-id",
    "forbidden-input-kind",
    "forbidden-binding-digest",
    "equivalence",
    "cacheHit",
    "tokenSavings",
  ]) {
    assert.doesNotMatch(projected, new RegExp(forbidden));
  }
});

test("rejects manipulated IntentABI IDs and downgrades incomplete trace links", () => {
  const model = normalizeViewModel(viewModel({
    semanticObservations: [
      semanticObservation({ id: "123E4567-E89B-42D3-A456-426614174000" }),
      semanticObservation({
        id: "223e4567-e89b-42d3-a456-426614174001",
        sourceRefs: [{
          path: ".sdlc/observations/intentabi/223e4567-e89b-42d3-a456-426614174001.json",
        }],
        rawHref: "/api/v1/source?path=.sdlc%2Frequirements%2FREQ-FIXTURE.json",
        link: {
          status: "linked",
          storyId: "ST-FIXTURE",
          traceIds: ["TRACE-FIXTURE"],
          sourceRefs: [
            { path: ".sdlc/requirements/REQ-FIXTURE.json", pointer: "/evidence/0" },
            { path: ".sdlc/traces/TRACE-FIXTURE.json", pointer: "/digest/0" },
          ],
        },
      }),
      semanticObservation({
        id: "323e4567-e89b-42d3-a456-426614174002",
        sourceRefs: [{ path: ".sdlc/traces/TRACE-FIXTURE.json" }],
      }),
      semanticObservation({
        sourceRefs: [{ path: ".sdlc/observations/intentabi/PROMPT_SECRET.json" }],
      }),
    ],
  }));

  assert.equal(model.semanticObservations.length, 1);
  assert.deepEqual(model.semanticObservations[0].link, {
    status: "unlinked",
    storyId: null,
    traceIds: [],
    sourceRefs: [],
  });
  assert.equal(
    model.semanticObservations[0].rawHref,
    "/api/v1/source?path=.sdlc%2Fobservations%2Fintentabi%2F223e4567-e89b-42d3-a456-426614174001.json",
  );
});

test("selection keys keep identical display IDs isolated across record types", () => {
  const sourceRefs = [{ path: INTENTABI_PATH }];
  const intent = recordSelectionKey({
    id: INTENTABI_EVENT_ID,
    type: "intentabi-codex-shadow",
    sourceRefs,
  });
  const contract = recordSelectionKey({
    id: INTENTABI_EVENT_ID,
    type: "contract",
    sourceRefs,
  });
  const verification = recordSelectionKey({
    id: INTENTABI_EVENT_ID,
    type: "test",
    sourceRefs,
  });

  assert.notEqual(intent, contract);
  assert.notEqual(intent, verification);
  assert.notEqual(contract, verification);
  assert.equal(intent, recordSelectionKey({
    id: INTENTABI_EVENT_ID,
    type: "intentabi-codex-shadow",
    sourceRefs,
  }));
  assert.notEqual(
    recordSelectionKey({ id: "TRACE-DUP", type: "decision", sourceRefs: [{ path: ".sdlc/traces/ST.jsonl", line: 1 }] }),
    recordSelectionKey({ id: "TRACE-DUP", type: "decision", sourceRefs: [{ path: ".sdlc/traces/ST.jsonl", line: 2 }] }),
  );
});

test("rejects unversioned or unsupported API responses", () => {
  assert.throws(() => normalizeViewModel({}), /Unsupported observatory schema/);
  assert.throws(
    () => normalizeViewModel({ schemaVersion: "change-observatory:view:v2" }),
    /expected change-observatory:view:v1/,
  );
});

test("visual QA preview helper is import-safe and validates its port", () => {
  assert.equal(parsePreviewPort([]), 4173);
  assert.equal(parsePreviewPort(["--port", "0"]), 0);
  assert.throws(() => parsePreviewPort(["--port"]), /between 0 and 65535/);
  assert.throws(() => parsePreviewPort(["--port", "NaN"]), /between 0 and 65535/);
  assert.throws(() => parsePreviewPort(["--port", "65536"]), /between 0 and 65535/);
});

test("groups equivalent diagnostics defensively in the browser model", () => {
  const model = normalizeViewModel(viewModel({
    diagnostics: [
      {
        code: "schema_version_missing",
        severity: "warning",
        message: "Legacy record.",
        provenance: "inferred",
        sourceRefs: [{ path: ".sdlc/one.json" }],
      },
      {
        code: "schema_version_missing",
        severity: "warning",
        message: "Legacy record.",
        provenance: "inferred",
        occurrences: 3,
        sourceRefs: [{ path: ".sdlc/two.json" }],
      },
    ],
  }));

  assert.equal(model.diagnostics.length, 1);
  assert.equal(model.diagnostics[0].occurrences, 4);
  assert.equal(model.diagnostics[0].sourceRefs.length, 2);
});

test("maps recorded narrative without generating missing facts", () => {
  const model = normalizeViewModel(
    viewModel({
      decisions: [
        {
          id: "DEC-FIXTURE",
          type: "decision",
          title: "Fixture decision",
          summary: "Recorded decision summary.",
          status: "approved",
          provenance: "recorded",
          sourceRefs: [{ path: ".sdlc/decisions/DEC-FIXTURE.json" }],
          narrative: {
            input_summary: "Recorded input.",
            output_summary: "Recorded output.",
            rationale: "Recorded rationale.",
            generated_explanation: "Codex-authored explanation from recorded evidence.",
            explanation_source: "codex-generated",
            alternatives: ["Recorded alternative."],
            chain_of_thought_included: false,
          },
        },
      ],
    }),
  );

  const narrative = narrativeFor(model.decisions[0]);
  assert.equal(narrative.inputs[0].title, "Recorded input.");
  assert.equal(narrative.outputs[0].title, "Recorded output.");
  assert.equal(narrative.rationale, "Recorded rationale.");
  assert.equal(narrative.generatedExplanation, "Codex-authored explanation from recorded evidence.");
  assert.equal(narrative.explanationLabel, "codex-generated");
  assert.equal(narrative.alternatives[0].title, "Recorded alternative.");
  assert.equal(narrative.chainOfThoughtIncluded, false);

  const absent = narrativeFor(model.summary.asked[0]);
  assert.equal(absent.generatedExplanation, null);
  assert.equal(absent.rationale, null);
  assert.deepEqual(absent.alternatives, []);
});

test("groups changes by recorded intent and labels absent intent explicitly", () => {
  const groups = groupChangesByIntent([
    { id: "1", intent: "launcher", phase: "implementation" },
    { id: "2", intent: "launcher", phase: "implementation" },
    { id: "3", intent: null, phase: "validation" },
    { id: "4", intent: null, phase: null },
  ]);

  assert.deepEqual(
    groups.map((group) => [group.intent, group.items.length]),
    [
      ["launcher", 2],
      ["validation", 1],
      ["Intent not recorded", 1],
    ],
  );
});

test("filters lineage by iteration and evidence-bearing phase", () => {
  const iterations = normalizeViewModel(viewModel()).iterations;
  assert.equal(filterIterations(iterations, { phase: "implementation" }).length, 1);
  assert.equal(filterIterations(iterations, { phase: "release" }).length, 0);
  assert.equal(filterIterations(iterations, { iteration: "missing" }).length, 0);
});

function storyIteration(id, { status = "ready", timestamp, phases = {} } = {}) {
  return {
    id,
    type: "iteration",
    title: `Story ${id}`,
    summary: `${id} summary.`,
    status,
    provenance: "recorded",
    currentPhase: "design",
    timestamp,
    sourceRefs: [{ path: `.sdlc/stories/${id}/story.json` }],
    phases: PHASES.map((phase) => ({
      phase,
      status: phases[phase] ?? "missing",
      provenance: phases[phase] ? "recorded" : "missing",
      sourceRefs: [],
    })),
  };
}

const ALL_PHASES_COMPLETE = Object.fromEntries(PHASES.map((phase) => [phase, "complete"]));

test("default dossier prefers the delivered story over earlier never-started stories", () => {
  const iterations = normalizeViewModel(viewModel({
    iterations: [
      ...["ST-001", "ST-002", "ST-003"].map((id, index) =>
        storyIteration(id, { timestamp: `2026-09-30T10:0${index}:00.000Z` })),
      storyIteration("ST-MVP", {
        timestamp: "2026-09-30T10:12:00.000Z",
        phases: ALL_PHASES_COMPLETE,
      }),
    ],
  })).iterations;
  assert.equal(iterationRelevance(iterations[0]), "idle");
  assert.equal(iterationRelevance(iterations[3]), "delivered");
  assert.equal(preferredDossierIteration(iterations).id, "ST-MVP");
});

test("default dossier prefers active work, then the most recent delivery, and skips superseded stories", () => {
  const iterations = normalizeViewModel(viewModel({
    iterations: [
      storyIteration("ST-OLD", {
        timestamp: "2026-09-01T00:00:00.000Z",
        phases: ALL_PHASES_COMPLETE,
      }),
      storyIteration("ST-ACTIVE", {
        timestamp: "2026-09-02T00:00:00.000Z",
        phases: { discovery: "complete", implementation: "inProgress" },
      }),
      storyIteration("ST-NEW", {
        status: "released",
        timestamp: "2026-09-03T00:00:00.000Z",
      }),
      storyIteration("ST-SUPERSEDED", {
        status: "superseded",
        timestamp: "2026-09-04T00:00:00.000Z",
        phases: { discovery: "complete", design: "inProgress" },
      }),
    ],
  })).iterations;
  assert.equal(iterationRelevance(iterations[3]), "superseded");
  assert.equal(preferredDossierIteration(iterations).id, "ST-ACTIVE");
  assert.equal(preferredDossierIteration(iterations.filter((it) => it.id !== "ST-ACTIVE")).id, "ST-NEW");
  assert.equal(
    preferredDossierIteration(iterations.filter((it) => it.id === "ST-SUPERSEDED")).id,
    "ST-SUPERSEDED",
    "a superseded story is still shown when it is the only recorded iteration",
  );
  assert.equal(
    preferredDossierIteration([
      storyIteration("ST-A"),
      { ...storyIteration("ST-B"), status: "cancelled" },
      storyIteration("ST-C"),
    ].map((iteration) => normalizeViewModel(viewModel({ iterations: [iteration] })).iterations[0])).id,
    "ST-A",
    "without evidence the first current story keeps the previous default",
  );
  assert.equal(preferredDossierIteration([]), null);
  assert.equal(preferredDossierIteration(undefined), null);
});

test("raw evidence links stay within canonical .sdlc sources", () => {
  assert.equal(isCanonicalEvidencePath(".sdlc/stories/ST-1/story.json"), true);
  assert.equal(isCanonicalEvidencePath(".sdlc/../package.json"), false);
  assert.equal(isCanonicalEvidencePath("README.md"), false);
  assert.equal(isCanonicalEvidencePath(".sdlc\\story.json"), false);
  assert.equal(
    rawHrefForPath(".sdlc/stories/ST-1/story.json"),
    "/api/v1/source?path=.sdlc%2Fstories%2FST-1%2Fstory.json",
  );
  assert.equal(
    safeRawHref("/api/v1/source?path=.sdlc%2Fstories%2FST-1%2Fstory.json"),
    "/api/v1/source?path=.sdlc%2Fstories%2FST-1%2Fstory.json",
  );
  assert.equal(safeRawHref("https://example.com/api/v1/source?path=.sdlc%2Fstory.json"), null);
  assert.equal(safeRawHref("/api/v1/source?path=..%2Fpackage.json"), null);
});

test("API client requests the versioned endpoint and normalizes its response", async () => {
  const calls = [];
  const accessToken = "a".repeat(43);
  const api = new ObservatoryApi({
    accessToken,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return new Response(JSON.stringify(viewModel()), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  const model = await api.load();
  assert.equal(model.project.id, "fixture-project");
  assert.equal(calls[0].url, "/api/v1/observatory");
  assert.equal(calls[0].options.cache, "no-store");
  assert.equal(calls[0].options.credentials, "same-origin");
  assert.equal(calls[0].options.redirect, "error");
  assert.equal(calls[0].options.headers.Authorization, `Bearer ${accessToken}`);
});

test("extracts only bounded base64url access tokens from the launch fragment", () => {
  const token = "Abc_123-".repeat(5);
  assert.equal(accessTokenFromHash(`#access_token=${token}`), token);
  assert.equal(accessTokenFromHash("#overview"), null);
  assert.equal(accessTokenFromHash("#access_token=short"), null);
  assert.equal(accessTokenFromHash("#access_token=contains%20space"), null);
});

test("API client refuses unsafe raw targets before fetch", async () => {
  let called = false;
  const api = new ObservatoryApi({
    fetchImpl: async () => {
      called = true;
      return new Response("{}", { status: 200 });
    },
  });

  await assert.rejects(
    api.loadRaw("https://example.com/evidence.json"),
    (error) => error instanceof ObservatoryApiError && error.code === "UNSAFE_RAW_SOURCE",
  );
  assert.equal(called, false);
});

test("API client loads and formats a canonical raw source", async () => {
  const calls = [];
  const api = new ObservatoryApi({
    fetchImpl: async (url) => {
      calls.push(url);
      return new Response('{"status":"recorded"}', {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  const raw = await api.loadRaw(
    "/api/v1/source?path=.sdlc%2Frequirements%2FREQ-FIXTURE.json",
  );
  assert.equal(calls[0], "/api/v1/source?path=.sdlc%2Frequirements%2FREQ-FIXTURE.json");
  assert.equal(raw, '{\n  "status": "recorded"\n}');
});

test("shipped UI is build-free, self-contained, accessible, and gradient-free", async () => {
  const [html, css, app, components, model, portfolio, portfolioComponents] = await Promise.all([
    readFile(new URL("index.html", UI_ROOT), "utf8"),
    readFile(new URL("styles.css", UI_ROOT), "utf8"),
    readFile(new URL("app.js", UI_ROOT), "utf8"),
    readFile(new URL("components.js", UI_ROOT), "utf8"),
    readFile(new URL("model.js", UI_ROOT), "utf8"),
    readFile(new URL("portfolio.js", UI_ROOT), "utf8"),
    readFile(new URL("portfolio-components.js", UI_ROOT), "utf8"),
  ]);

  assert.match(html, /<script type="module" src="\.\/app\.js"><\/script>/);
  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /class="skip-link"/);
  assert.match(html, /id="skip-link"[^>]*data-i18n="Skip to project evidence"/);
  assert.match(html, /aria-label="Change Observatory"/);
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /<main id="workspace"[^>]*aria-labelledby="workspace-heading"/);
  assert.match(html, /<h1 id="workspace-heading"[^>]*>Project evidence<\/h1>/);
  assert.equal((html.match(/<h1\b/gu) ?? []).length, 1);
  assert.match(html, /id="primary-view"[^>]*aria-labelledby="workspace-heading"/);
  assert.match(html, /id="raw-drawer"[^>]*aria-labelledby="raw-heading"/);
  assert.match(html, /data-action="toggle-raw"[^>]*aria-expanded="false"[^>]*aria-controls="raw-content"/);
  assert.doesNotMatch(html, /role="listitem"[^>]*data-view|role="list"[^>]*nav-primary/);
  for (const label of [
    "Overview",
    "Timeline",
    "Contracts",
    "Decisions",
    "Changes",
    "Intent evidence",
    "Verification",
    "What was asked?",
    "What changed?",
    "Why was it decided?",
  ]) {
    assert.match(html, new RegExp(label.replace(/[?]/g, "\\?")));
  }
  assert.doesNotMatch(html, /https?:\/\//);
  assert.doesNotMatch(css, /gradient\s*\(/i);
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
  assert.match(css, /max-width:\s*430px/);
  assert.match(components, /Plain-language explanation/);
  for (const lane of ["Asked", "Decided", "Contract", "Done", "Verified"]) {
    assert.match(model, new RegExp(`label: "${lane}"`));
  }
  assert.match(components, /Recorded rationale/);
  assert.match(components, /Generated explanation/);
  assert.match(components, /Dossier iteration/);
  assert.match(components, /select-iteration/);
  assert.match(components, /laneKey !== "verified"/);
  assert.match(components, /Open raw source/);
  assert.match(components, /Release evidence/);
  assert.match(components, /Unlinked project evidence/);
  assert.doesNotMatch(components, /free.text|timestamp.*join|filename.*join/i);
  assert.match(components, /Alternatives rejected/);
  assert.match(components, /No plain-language explanation was recorded/);
  assert.match(components, /MAC present · not verified/);
  assert.doesNotMatch(components, /intent equivalence|cache hit|token savings/i);
  assert.match(app, /\/api\/v1\/observatory|ObservatoryApi/);
  assert.match(app, /selectedIterationId/);
  assert.match(app, /case "select-iteration"/);
  assert.match(app, /filter === "dossier"/);
  assert.match(app, /localizedErrorGuidance/);
  assert.match(app, /rawSourceErrorText/);
  assert.match(app, /LatestRequestCoordinator/);
  assert.match(app, /loadPortfolioProject/);
  assert.match(app, /portfolioProjectId/);
  assert.match(app, /Technical details \(optional\)/);
  assert.match(portfolio, /mode=portfolio|modes\[0\] === "portfolio"/);
  assert.match(portfolio, /controller\?\.abort/);
  assert.match(portfolioComponents, /All projects/);
  assert.match(portfolioComponents, /select-project/);
  assert.match(portfolioComponents, /aria-label/);
  assert.doesNotMatch(app, /fixture|demo|mock/i);
  assert.doesNotMatch(`${portfolio}\n${portfolioComponents}`, /https?:\/\//u);
});
