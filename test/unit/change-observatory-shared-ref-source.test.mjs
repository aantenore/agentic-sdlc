import "../helpers/test-isolation.mjs";

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createSharedRefSource,
  observeFetchSeconds,
  resolveObservatoryRef,
} from "../../lib/change-observatory/shared-ref-source.mjs";

function git(cwd, ...args) {
  const result = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.invalid",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.invalid",
    },
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function write(root, relative, content) {
  fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
  fs.writeFileSync(path.join(root, relative), content);
}

// A shared repository with records on main and a clone sitting on a story
// branch whose local files differ from what main published.
function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "observatory-ref-"));
  const shared = path.join(base, "shared.git");
  const publisher = path.join(base, "publisher");
  const viewer = path.join(base, "viewer");
  git(base, "init", "--quiet", "--bare", "--initial-branch=main", shared);
  git(base, "clone", "--quiet", shared, publisher);
  write(publisher, ".sdlc/config.json", "{}\n");
  write(publisher, ".sdlc/stories/ST-1/story.json", "{\"id\":\"ST-1\"}\n");
  git(publisher, "add", ".");
  git(publisher, "commit", "--quiet", "-m", "first");
  git(publisher, "push", "--quiet", "origin", "HEAD:main");
  git(base, "clone", "--quiet", shared, viewer);
  git(viewer, "checkout", "--quiet", "-b", "story");
  write(viewer, ".sdlc/stories/LOCAL/story.json", "{\"id\":\"LOCAL\"}\n");
  return { base, publisher, viewer };
}

test("records are read from the shared base branch, not the local files", async (t) => {
  const { base, publisher, viewer } = fixture();
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));

  const resolved = resolveObservatoryRef(viewer);
  assert.equal(resolved.ref, "origin/main");
  assert.equal(resolved.remote, "origin");
  assert.equal(resolved.branch, "main");

  const snapshotRoot = path.join(base, "snapshot");
  const source = createSharedRefSource(viewer, { snapshotRoot, fetchSeconds: 0 });
  assert.equal(source.root, snapshotRoot);
  assert.ok(fs.existsSync(path.join(snapshotRoot, ".sdlc/stories/ST-1/story.json")));
  assert.ok(!fs.existsSync(path.join(snapshotRoot, ".sdlc/stories/LOCAL")));
  assert.equal(source.info().ref, "origin/main");
  assert.equal(source.info().commit, resolved.commit);

  // Another computer publishes: the next refresh fetches and follows main.
  fs.rmSync(path.join(publisher, ".sdlc/stories/ST-1"), { recursive: true });
  write(publisher, ".sdlc/stories/ST-2/story.json", "{\"id\":\"ST-2\"}\n");
  git(publisher, "add", "-A");
  git(publisher, "commit", "--quiet", "-m", "second");
  git(publisher, "push", "--quiet", "origin", "HEAD:main");
  assert.equal(await source.refresh(), true);
  assert.ok(fs.existsSync(path.join(snapshotRoot, ".sdlc/stories/ST-2/story.json")));
  assert.ok(!fs.existsSync(path.join(snapshotRoot, ".sdlc/stories/ST-1")));
  assert.ok(source.info().fetchedAt);
  assert.equal(await source.refresh(), false);
});

test("an explicit ref is shown and a missing one is refused", (t) => {
  const { base, viewer } = fixture();
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const resolved = resolveObservatoryRef(viewer, { ref: "story" });
  assert.equal(resolved.ref, "story");
  assert.equal(resolved.remote, null);
  assert.equal(resolveObservatoryRef(viewer, { ref: "no-such-ref" }), null);
});

test("the fetch interval comes from the environment", () => {
  assert.equal(observeFetchSeconds({}), 60);
  assert.equal(observeFetchSeconds({ AGENTIC_SDLC_OBSERVE_FETCH_SECONDS: "0" }), 0);
  assert.equal(observeFetchSeconds({ AGENTIC_SDLC_OBSERVE_FETCH_SECONDS: "15" }), 15);
  assert.equal(observeFetchSeconds({ AGENTIC_SDLC_OBSERVE_FETCH_SECONDS: "x" }), 60);
});
