import "./helpers/test-isolation.mjs";

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildObservatoryViewModel } from "../lib/change-observatory/index.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(repoRoot, "bin/agentic-sdlc.mjs");

function mustRun(project, args) {
  const result = spawnSync(process.execPath, [cli, ...args, "--root", project], { encoding: "utf8", timeout: 60_000 });
  assert.equal(result.status, 0, `${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

function findIterations(value, depth = 0) {
  if (!value || typeof value !== "object" || depth > 4) return null;
  if (Array.isArray(value.iterations)) return value.iterations;
  for (const child of Object.values(value)) {
    const found = findIterations(child, depth + 1);
    if (found) return found;
  }
  return null;
}

test("a fix story records its link, inherits requirements, starts in design and shows in the Observatory", async () => {
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sdlc-story-fix-")));
  mustRun(project, ["init", "--project-name", "Fix fixture"]);
  mustRun(project, ["requirement", "propose", "--id", "REQ-A", "--title", "A", "--summary", "Outcome", "--acceptance", "Works", "--autonomy-ceiling", "supervised", "--write-path", "src"]);
  mustRun(project, ["requirement", "approve", "--id", "REQ-A", "--actor-type", "human", "--approval-source", "explicit-user", "--summary", "ok"]);
  mustRun(project, ["story", "create", "--id", "ST-A", "--title", "A", "--requirement", "REQ-A"]);

  const created = JSON.parse(mustRun(project, ["story", "create", "--id", "ST-A-FIX", "--title", "Fix A", "--fixes", "ST-A", "--json"]));
  assert.deepEqual(created.story.fixes, { story_id: "ST-A", incident_id: null });
  assert.deepEqual(created.story.links.requirements, ["REQ-A"]);
  assert.equal(created.fix_short_cycle.status, "in_design");
  for (const phase of ["discovery", "analysis"]) {
    const step = JSON.parse(fs.readFileSync(path.join(project, ".sdlc/stories/ST-A-FIX/steps", `${phase}.json`), "utf8"));
    assert.equal(step.status, "completed");
    assert.match(step.summary, /Inherited from fixed story ST-A/u);
  }

  fs.mkdirSync(path.join(project, ".sdlc/operations"), { recursive: true });
  fs.writeFileSync(path.join(project, ".sdlc/operations/INC-1.json"), JSON.stringify({ kind: "incident", id: "INC-1", story_id: "ST-A" }));
  const fromIncident = JSON.parse(mustRun(project, ["story", "create", "--id", "ST-A-FIX-2", "--title", "Fix A again", "--incident", "INC-1", "--full-cycle", "--json"]));
  assert.deepEqual(fromIncident.story.fixes, { story_id: "ST-A", incident_id: "INC-1" });
  assert.equal(fromIncident.fix_short_cycle, undefined);

  const iterations = findIterations(await buildObservatoryViewModel(project));
  const byId = new Map(iterations.map((iteration) => [iteration.id, iteration]));
  assert.deepEqual(byId.get("ST-A").fixedBy, ["ST-A-FIX", "ST-A-FIX-2"]);
  assert.deepEqual(byId.get("ST-A-FIX-2").fixes, { storyId: "ST-A", incidentId: "INC-1" });
});
