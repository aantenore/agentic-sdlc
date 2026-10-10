import assert from "node:assert/strict";
import test from "node:test";

import { compareStoryTrace, storyTraceFileReferences } from "../../lib/story-trace-publish.mjs";

const event = (n, extra = {}) => JSON.stringify({ id: `TR-${n}`, story_id: "ST-1", ...extra });
const trace = (...events) => `${events.join("\n")}\n`;

test("a local trace holding every base event is a superset and gets published", () => {
  const base = trace(event(1), event(2));
  assert.equal(compareStoryTrace(base, trace(event(1), event(2), event(3))), "superset");
  assert.equal(compareStoryTrace(base, base), "same");
  assert.equal(compareStoryTrace("", trace(event(1))), "superset");
});

test("a base trace with events the local copy lacks is a real divergence", () => {
  const base = trace(event(1), event(2), event(9));
  assert.equal(compareStoryTrace(base, trace(event(1), event(2), event(3))), "diverged");
});

test("files named in the trace that belong to the story are returned, nothing else", () => {
  const text = trace(
    event(1, { evidence: ["evidence/ST-1/log/commit6.txt", "evidence/ST-1/log/push4.txt"], summary: "see evidence/ST-10/log/x.txt" }),
    event(2, { request: { path: "src/app.mjs", other: "../ST-1/secret.txt" } }),
    "not json",
  );
  assert.deepEqual(storyTraceFileReferences(text, "ST-1"), ["evidence/ST-1/log/commit6.txt", "evidence/ST-1/log/push4.txt"]);
});
