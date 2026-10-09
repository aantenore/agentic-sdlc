import test from "node:test";
import assert from "node:assert/strict";

import {
  inspectDependencyEdge,
  isDependencyEdgeRetired,
  resolveDependencyUpstream,
} from "../../lib/engine/story.mjs";

const edge = (from, to, requiredState = "merged") => ({
  from,
  to,
  type: "blocks",
  blocks: "analysis",
  required_state: requiredState,
});

const open = (status = "draft", phase = "design") => ({
  status,
  phase,
  terminal: false,
  blocked: false,
  closed: false,
});

const superseded = (...replacementIds) => ({
  status: "superseded",
  phase: "design",
  terminal: true,
  blocked: false,
  closed: true,
  source: "story_closure",
  closure: {
    event: "superseded",
    replacement_id: replacementIds.length === 1 ? replacementIds[0] : null,
    replacement_ids: replacementIds,
  },
});

// A dependency query answered entirely from memory: no project files are read.
function query(lifecycles, holders = {}) {
  return {
    stories_by_id: new Map(Object.keys(lifecycles).map((id) => [id, { id }])),
    lifecycle_by_story: new Map(Object.entries(lifecycles)),
    registry: { links: [] },
    traces_by_story: new Map(),
    contract_state_by_story: new Map(),
    claim_holder: (storyId) => (Object.hasOwn(holders, storyId) ? holders[storyId] : null),
  };
}

const context = {};

test("a story split into several replacements is never followed to one of them", () => {
  const lifecycles = {
    "ST-ORCH-001": superseded("ST-ORCH-001A", "ST-ORCH-001B", "ST-ORCH-001C"),
    "ST-ORCH-001A": open("in_progress", "implementation"),
    "ST-ORCH-001B": open(),
    "ST-ORCH-001C": open(),
    "ST-CHAT-001A": open(),
  };
  const upstream = resolveDependencyUpstream(context, "ST-ORCH-001", query(lifecycles));
  assert.equal(upstream.split, true);
  assert.equal(upstream.story_id, "ST-ORCH-001");
  assert.deepEqual(upstream.replacements, ["ST-ORCH-001A", "ST-ORCH-001B", "ST-ORCH-001C"]);

  const state = inspectDependencyEdge(context, edge("ST-CHAT-001A", "ST-ORCH-001"), null, query(lifecycles));
  assert.equal(state.satisfied, false);
  assert.equal(state.blocking, true);
  assert.equal(state.needs_review, true);
  assert.deepEqual(state.upstream.replacements, ["ST-ORCH-001A", "ST-ORCH-001B", "ST-ORCH-001C"]);
  assert.match(state.message, /^ST-CHAT-001A depends on ST-ORCH-001, which was split into ST-ORCH-001A, ST-ORCH-001B, ST-ORCH-001C: /u);
  assert.match(state.message, /a person must decide which of them ST-CHAT-001A depends on/u);
  assert.match(state.message, /--redirect ST-CHAT-001A:ST-ORCH-001:<ST-ORCH-001A\|ST-ORCH-001B\|ST-ORCH-001C>/u);

  // Even a merged first replacement does not satisfy the unreviewed edge.
  lifecycles["ST-ORCH-001A"] = { ...open("done", "release"), terminal: true };
  assert.equal(inspectDependencyEdge(context, edge("ST-CHAT-001A", "ST-ORCH-001", "done"), null, query(lifecycles)).satisfied, false);

  // A soft edge waits for the same decision without blocking.
  const related = inspectDependencyEdge(context, { ...edge("ST-CHAT-001A", "ST-ORCH-001"), type: "related" }, null, query(lifecycles));
  assert.equal(related.blocking, false);
  assert.equal(related.needs_review, true);

  // One of the replacements depending on the split story is satisfied by the split itself.
  const own = inspectDependencyEdge(context, edge("ST-ORCH-001B", "ST-ORCH-001"), null, query(lifecycles));
  assert.equal(own.satisfied, true);
  assert.equal(own.blocking, false);
});

test("a split reached through an earlier single replacement names both steps", () => {
  const lifecycles = {
    "ST-OLD": superseded("ST-ORCH-001"),
    "ST-ORCH-001": superseded("ST-ORCH-001A", "ST-ORCH-001B"),
    "ST-ORCH-001A": open(),
    "ST-ORCH-001B": open(),
    "ST-CHAT-001": open(),
  };
  const state = inspectDependencyEdge(context, edge("ST-CHAT-001", "ST-OLD"), null, query(lifecycles));
  assert.equal(state.needs_review, true);
  assert.deepEqual(state.upstream.chain, ["ST-OLD", "ST-ORCH-001"]);
  assert.match(state.message, /^ST-CHAT-001 depends on ST-OLD → superseded by ST-ORCH-001, which was split into ST-ORCH-001A, ST-ORCH-001B/u);
});

test("a single replacement is followed and the message shows where it stands", () => {
  const lifecycles = {
    "ST-ORCH-001": superseded("ST-ORCH-001A"),
    "ST-ORCH-001A": open("in_progress", "implementation"),
    "ST-CHAT-001A": open(),
  };
  const elsewhere = inspectDependencyEdge(
    context,
    edge("ST-CHAT-001A", "ST-ORCH-001"),
    null,
    query(lifecycles, { "ST-ORCH-001A": { agent: "agente-orch-001a", elsewhere: true } }),
  );
  assert.equal(elsewhere.satisfied, false);
  assert.equal(elsewhere.blocking, true);
  assert.equal(elsewhere.needs_review, undefined);
  assert.equal(elsewhere.upstream.story_id, "ST-ORCH-001A");
  assert.equal(
    elsewhere.message,
    "ST-CHAT-001A depends on ST-ORCH-001 → superseded by ST-ORCH-001A "
      + "[in progress (implementation), claimed by agente-orch-001a on another computer] "
      + "(blocks, analysis, requires merged)",
  );

  const here = inspectDependencyEdge(
    context,
    edge("ST-CHAT-001A", "ST-ORCH-001"),
    null,
    query(lifecycles, { "ST-ORCH-001A": { agent: "agente-orch-001a", elsewhere: false } }),
  );
  assert.match(here.message, /\[in progress \(implementation\), claimed by agente-orch-001a\] /u);

  const direct = inspectDependencyEdge(context, edge("ST-CHAT-001A", "ST-ORCH-001A"), null, query({
    "ST-ORCH-001A": open("ready", "analysis"),
    "ST-CHAT-001A": open(),
  }));
  assert.equal(direct.message, "ST-CHAT-001A depends on ST-ORCH-001A [ready (analysis), not claimed] (blocks, analysis, requires merged)");

  const ready = inspectDependencyEdge(context, edge("ST-CHAT-001A", "ST-ORCH-001", "ready"), null, query({
    ...lifecycles,
    "ST-ORCH-001A": open("ready", "ready"),
  }));
  assert.equal(ready.satisfied, true);
  assert.equal(ready.message, "ST-CHAT-001A depends on ST-ORCH-001 → superseded by ST-ORCH-001A [ready, not claimed] (blocks, analysis, requires ready)");
});

test("only edges marked retired leave the evaluated graph", () => {
  assert.equal(isDependencyEdgeRetired({ ...edge("A", "B"), status: "retired" }), true);
  assert.equal(isDependencyEdgeRetired({ ...edge("A", "B"), status: "RETIRED" }), true);
  assert.equal(isDependencyEdgeRetired(edge("A", "B")), false);
  assert.equal(isDependencyEdgeRetired({ ...edge("A", "B"), status: "approved" }), false);
});
