import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  discoverBaselineSourcePaths,
  normalizeBaselineSourcePolicy,
} from "../../lib/baseline-source-discovery.mjs";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-sdlc-baseline-"));
  const write = (relativePath, content = relativePath) => {
    const filePath = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
    return filePath;
  };
  return { root, write };
}

test("directory discovery uses source extensions rather than KB index extensions", (t) => {
  const project = fixture();
  t.after(() => fs.rmSync(project.root, { recursive: true, force: true }));
  project.write("lib/a.mjs");
  project.write("lib/b.js");
  project.write("lib/c.ts");
  project.write("lib/d.py");
  project.write("lib/ignored.bin");

  const result = discoverBaselineSourcePaths({
    projectRoot: project.root,
    requestedPaths: ["lib"],
    policy: { source_extensions: [".mjs", ".js", ".ts", ".py"] },
  });

  assert.deepEqual(result.paths, ["lib/a.mjs", "lib/b.js", "lib/c.ts", "lib/d.py"]);
  assert.deepEqual(result.excluded, [{ path: "lib/ignored.bin", reason: "extension_not_allowed" }]);
});

test("repository discovery excludes canonical evidence, dependencies, and build output", (t) => {
  const project = fixture();
  t.after(() => fs.rmSync(project.root, { recursive: true, force: true }));
  project.write("src/index.mjs");
  project.write(".sdlc/traces/project.jsonl");
  project.write("node_modules/pkg/index.js");
  project.write("dist/bundle.js");
  project.write("coverage/result.json");

  const result = discoverBaselineSourcePaths({ projectRoot: project.root, requestedPaths: ["."] });

  assert.deepEqual(result.paths, ["src/index.mjs"]);
  assert.deepEqual(
    result.excluded.map((item) => [item.path, item.reason]),
    [
      [".sdlc/", "excluded_directory"],
      ["coverage/", "excluded_directory"],
      ["dist/", "excluded_directory"],
      ["node_modules/", "excluded_directory"],
    ],
  );
});

test("explicit files remain compatible even when their extension is not discoverable", (t) => {
  const project = fixture();
  t.after(() => fs.rmSync(project.root, { recursive: true, force: true }));
  project.write("evidence/custom.data", "evidence");

  const result = discoverBaselineSourcePaths({
    projectRoot: project.root,
    requestedPaths: ["evidence/custom.data"],
    policy: { source_extensions: [".mjs"] },
  });

  assert.deepEqual(result.paths, ["evidence/custom.data"]);
});

test("discovery is deterministic and reports bounded truncation", (t) => {
  const project = fixture();
  t.after(() => fs.rmSync(project.root, { recursive: true, force: true }));
  project.write("src/z.mjs");
  project.write("src/a.mjs");
  project.write("src/m.mjs");

  const options = {
    projectRoot: project.root,
    requestedPaths: ["src"],
    policy: { max_discovered_files: 2 },
  };
  const first = discoverBaselineSourcePaths(options);
  const second = discoverBaselineSourcePaths(options);

  assert.deepEqual(first, second);
  assert.deepEqual(first.paths, ["src/a.mjs", "src/m.mjs"]);
  assert.equal(first.truncated, true);
  assert.equal(first.discovered_count, 2);
});

test("discovery keeps distinct native file identities and deduplicates hard links", (t) => {
  const project = fixture();
  t.after(() => fs.rmSync(project.root, { recursive: true, force: true }));
  const first = project.write("src/first.mjs", "first\n");
  project.write("src/second.mjs", "second\n");
  try {
    fs.linkSync(first, path.join(project.root, "src", "first-alias.mjs"));
  } catch (error) {
    if (process.platform === "win32" && ["EPERM", "EACCES"].includes(error?.code)) return;
    throw error;
  }

  const result = discoverBaselineSourcePaths({
    projectRoot: project.root,
    requestedPaths: ["src"],
  });

  assert.equal(result.discovered_count, 2);
  assert.deepEqual(result.paths, ["src/first-alias.mjs", "src/second.mjs"]);
});

test("source policy validates extensions, directory names, and limits", () => {
  assert.throws(
    () => normalizeBaselineSourcePolicy({ source_extensions: ["mjs"] }),
    /Invalid baseline source extension/u,
  );
  assert.throws(
    () => normalizeBaselineSourcePolicy({ excluded_directories: ["../outside"] }),
    /Invalid excluded baseline directory/u,
  );
  assert.throws(
    () => normalizeBaselineSourcePolicy({ max_discovered_files: 0 }),
    /must be a positive integer/u,
  );
});

test("symlinks are excluded from recursive discovery", { skip: process.platform === "win32" }, (t) => {
  const project = fixture();
  t.after(() => fs.rmSync(project.root, { recursive: true, force: true }));
  project.write("src/real.mjs");
  fs.symlinkSync(path.join(project.root, "src", "real.mjs"), path.join(project.root, "src", "alias.mjs"));

  const result = discoverBaselineSourcePaths({ projectRoot: project.root, requestedPaths: ["src"] });

  assert.deepEqual(result.paths, ["src/real.mjs"]);
  assert.deepEqual(result.excluded, [{ path: "src/alias.mjs", reason: "symlink" }]);
});

test("baseline roots come from the project policy and fall back to the shared defaults", async (t) => {
  const project = fixture();
  t.after(() => fs.rmSync(project.root, { recursive: true, force: true }));
  project.write("src/a.mjs");
  project.write("services/billing/b.cs");
  project.write("checks/c.mjs");
  const { inferSourceRoots, inferTestRoots } = await import("../../lib/engine/project.mjs");

  const defaults = { root: project.root, config: { baseline_policy: {} } };
  assert.deepEqual(inferSourceRoots(defaults), ["src", "services"]);
  assert.deepEqual(inferTestRoots(defaults), []);

  const configured = {
    root: project.root,
    config: { baseline_policy: { source_roots: ["services", "missing"], test_roots: ["checks"] } },
  };
  assert.deepEqual(inferSourceRoots(configured), ["services"]);
  assert.deepEqual(inferTestRoots(configured), ["checks"]);

  const discovered = discoverBaselineSourcePaths({
    projectRoot: project.root,
    requestedPaths: inferSourceRoots(defaults),
  });
  assert.deepEqual(discovered.paths, ["services/billing/b.cs", "src/a.mjs"]);
});

test("discovery leaves out what Git ignores without entering ignored folders", (t) => {
  const project = fixture();
  t.after(() => fs.rmSync(project.root, { recursive: true, force: true }));
  project.write("apps/web/page.tsx");
  project.write("apps/web/next-env.d.ts");
  project.write("apps/web/.next-cache/chunk.js");
  project.write("apps/web/layout.tsx");
  const gitVisible = {
    files: new Set(["apps/web/page.tsx", "apps/web/layout.tsx"]),
    directories: new Set([".", "apps", "apps/web"]),
  };

  const result = discoverBaselineSourcePaths({
    projectRoot: project.root,
    requestedPaths: ["apps", "apps/web/next-env.d.ts"],
    policy: { source_extensions: [".tsx", ".ts", ".js"] },
    gitVisible,
  });

  // A file requested by name stays included.
  assert.deepEqual(result.paths, ["apps/web/layout.tsx", "apps/web/next-env.d.ts", "apps/web/page.tsx"]);
  assert.deepEqual(result.excluded, [
    { path: "apps/web/.next-cache/", reason: "git_ignored" },
    { path: "apps/web/next-env.d.ts", reason: "git_ignored" },
  ]);
});
