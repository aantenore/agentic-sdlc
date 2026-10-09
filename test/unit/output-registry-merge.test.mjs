import assert from "node:assert/strict";
import test from "node:test";

import { mergeOutputRegistries } from "../../lib/output-registry-merge.mjs";

const base = { schema_version: "v1", templates: [{ id: "T1", status: "draft" }], links: [], decisions: [], updated_at: "2026-01-01" };

test("entries added on each side are kept, remote order first", () => {
  const local = { ...base, decisions: [{ id: "D-LOCAL" }], updated_at: "2026-01-03" };
  const remote = { ...base, decisions: [{ id: "D-REMOTE" }], updated_at: "2026-01-02" };
  const merged = mergeOutputRegistries({ base, local, remote });
  assert.deepEqual(merged.conflicts, []);
  assert.deepEqual(merged.registry.decisions.map((entry) => entry.id), ["D-REMOTE", "D-LOCAL"]);
  assert.equal(merged.registry.updated_at, "2026-01-03");
  assert.equal(merged.changed, true);
});

test("an entry changed on one side only takes that side; on both sides it is a conflict", () => {
  const approved = { ...base, templates: [{ id: "T1", status: "approved" }] };
  assert.deepEqual(mergeOutputRegistries({ base, local: base, remote: approved }).registry.templates, approved.templates);
  assert.deepEqual(mergeOutputRegistries({ base, local: approved, remote: base }).registry.templates, approved.templates);
  const retired = { ...base, templates: [{ id: "T1", status: "retired" }] };
  const conflict = mergeOutputRegistries({ base, local: approved, remote: retired });
  assert.equal(conflict.registry, null);
  assert.deepEqual(conflict.conflicts, ["templates T1"]);
});
