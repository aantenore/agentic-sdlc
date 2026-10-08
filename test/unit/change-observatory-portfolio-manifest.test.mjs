import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  MAX_PORTFOLIO_MANIFEST_BYTES,
  PORTFOLIO_MANIFEST_SCHEMA_VERSION,
  assertPortfolioManifestBoundaries,
  loadPortfolioManifest,
} from "../../lib/change-observatory/portfolio-manifest.mjs";
import { captureDirectoryIdentity } from "../../lib/change-observatory/path-safety.mjs";
import { requireSymlinkSupport } from "../helpers/symlink-support.mjs";

async function fixture(t, name = "valid") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `observatory-portfolio-${name}-`));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "projects", "alpha"), { recursive: true });
  await fs.mkdir(path.join(root, "projects", "beta"), { recursive: true });
  return fs.realpath(root);
}

async function writeManifest(root, document, relativePath = "portfolio.json") {
  const target = path.join(root, ...relativePath.split("/"));
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, `${JSON.stringify(document, null, 2)}\n`);
}

function manifest(projects = [
  { id: "alpha", path: "projects/alpha" },
  { id: "beta", path: "projects/beta" },
]) {
  return { schema_version: PORTFOLIO_MANIFEST_SCHEMA_VERSION, projects };
}

test("ships a closed v1 schema with the same project bounds as the loader", async () => {
  const schema = JSON.parse(await fs.readFile(
    new URL("../../schemas/portfolio-manifest.schema.json", import.meta.url),
    "utf8",
  ));

  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ["schema_version", "projects"]);
  assert.equal(schema.properties.schema_version.const, PORTFOLIO_MANIFEST_SCHEMA_VERSION);
  assert.equal(schema.properties.projects.minItems, 1);
  assert.equal(schema.properties.projects.maxItems, 64);
  assert.equal(schema.properties.projects.items.additionalProperties, false);
  assert.deepEqual(schema.properties.projects.items.required, ["id", "path"]);
});

test("loads an explicit bounded portfolio manifest in declared order", async (t) => {
  const root = await fixture(t);
  await writeManifest(root, manifest());

  const loaded = await loadPortfolioManifest(root, "portfolio.json");

  assert.equal(loaded.schemaVersion, PORTFOLIO_MANIFEST_SCHEMA_VERSION);
  assert.equal(loaded.portfolioRoot, root);
  assert.deepEqual(loaded.projects.map(({ id, path: projectPath }) => ({ id, path: projectPath })), [
    { id: "alpha", path: "projects/alpha" },
    { id: "beta", path: "projects/beta" },
  ]);
  await assertPortfolioManifestBoundaries(loaded);
});

test("accepts the maximum of 64 distinct projects", async (t) => {
  const root = await fixture(t, "maximum");
  const projects = [];
  for (let index = 0; index < 64; index += 1) {
    const id = `project-${index}`;
    const projectPath = `maximum/${id}`;
    await fs.mkdir(path.join(root, ...projectPath.split("/")), { recursive: true });
    projects.push({ id, path: projectPath });
  }
  await writeManifest(root, manifest(projects));

  const loaded = await loadPortfolioManifest(root, "portfolio.json");

  assert.equal(loaded.projects.length, 64);
  assert.deepEqual(loaded.projects.map((project) => project.id), projects.map((project) => project.id));
});

test("requires an explicit existing JSON manifest without fallback discovery", async (t) => {
  const root = await fixture(t, "explicit");
  await writeManifest(root, manifest(), "nested/portfolio.json");

  await assert.rejects(
    () => loadPortfolioManifest(root, "portfolio.json"),
    (error) => error.code === "portfolio_manifest_not_found"
      && error.statusCode === 404
      && error.message.includes('"portfolio.json"'),
  );
  await assert.rejects(
    () => loadPortfolioManifest(root, "nested/portfolio.txt"),
    (error) => error.code === "invalid_portfolio_manifest_path",
  );
});

test("rejects duplicate identifiers and normalized project paths", async (t) => {
  const root = await fixture(t, "duplicates");
  await writeManifest(root, manifest([
    { id: "same", path: "projects/alpha" },
    { id: "same", path: "projects/beta" },
  ]));
  await assert.rejects(() => loadPortfolioManifest(root, "portfolio.json"), (error) => error.code === "duplicate_project_id");

  await writeManifest(root, manifest([
    { id: "alpha", path: "projects/alpha" },
    { id: "beta", path: "projects/alpha" },
  ]));
  await assert.rejects(() => loadPortfolioManifest(root, "portfolio.json"), (error) => error.code === "duplicate_project_path");
});

test("rejects distinct paths that identify the same physical project directory", async (t) => {
  const root = await fixture(t, "physical-duplicate");
  const canonical = await fs.stat(path.join(root, "projects", "alpha"), { bigint: true });
  let alias;
  try {
    alias = await fs.stat(path.join(root, "projects", "ALPHA"), { bigint: true });
  } catch {
    t.skip("fixture filesystem is case-sensitive and exposes no safe directory alias");
    return;
  }
  if (canonical.dev !== alias.dev || canonical.ino !== alias.ino) {
    t.skip("fixture filesystem is case-sensitive and exposes no safe directory alias");
    return;
  }
  await writeManifest(root, manifest([
    { id: "lower", path: "projects/alpha" },
    { id: "upper", path: "projects/ALPHA" },
  ]));

  await assert.rejects(
    () => loadPortfolioManifest(root, "portfolio.json"),
    (error) => error.code === "duplicate_project_directory",
  );
});

test("rejects every non-canonical project path form", async (t) => {
  const root = await fixture(t, "paths");
  const forbidden = [
    "",
    " ",
    " projects/alpha",
    "projects/alpha ",
    "/projects/alpha",
    "C:/projects/alpha",
    "C:\\projects\\alpha",
    "//server/share",
    "\\\\server\\share",
    "https://example.invalid/project",
    "file:projects/alpha",
    "~/projects/alpha",
    "$PROJECT_ROOT/alpha",
    "${PROJECT_ROOT}/alpha",
    "%PROJECT_ROOT%/alpha",
    "projects/*",
    "projects/?",
    "projects/[a]",
    "projects/{alpha,beta}",
    "projects\\alpha",
    ".",
    "..",
    "./projects/alpha",
    "projects/./alpha",
    "projects/../alpha",
    "projects//alpha",
  ];

  for (const projectPath of forbidden) {
    await writeManifest(root, manifest([{ id: "unsafe", path: projectPath }]));
    await assert.rejects(
      () => loadPortfolioManifest(root, "portfolio.json"),
      (error) => error.code === "invalid_project_path",
      `expected rejection for ${JSON.stringify(projectPath)}`,
    );
  }
});

test("applies the same canonical path rules to the explicit manifest location", async (t) => {
  const root = await fixture(t, "manifest-paths");
  await writeManifest(root, manifest());
  const forbidden = [
    " portfolio.json",
    "/portfolio.json",
    "C:/portfolio.json",
    "//server/portfolio.json",
    "https://example.invalid/portfolio.json",
    "~/portfolio.json",
    "$MANIFEST.json",
    "%MANIFEST%/portfolio.json",
    "*.json",
    "nested\\portfolio.json",
    "nested/../portfolio.json",
  ];

  for (const manifestPath of forbidden) {
    await assert.rejects(
      () => loadPortfolioManifest(root, manifestPath),
      (error) => error.code === "invalid_manifest_path",
      `expected rejection for ${JSON.stringify(manifestPath)}`,
    );
  }
});

test("enforces the closed manifest shape and the 1 to 64 project bound", async (t) => {
  const root = await fixture(t, "shape");
  const invalidDocuments = [
    null,
    [],
    {},
    { schema_version: "portfolio-manifest:v2", projects: [{ id: "alpha", path: "projects/alpha" }] },
    { schema_version: PORTFOLIO_MANIFEST_SCHEMA_VERSION, projects: [], extra: true },
    { schema_version: PORTFOLIO_MANIFEST_SCHEMA_VERSION, projects: [] },
    {
      schema_version: PORTFOLIO_MANIFEST_SCHEMA_VERSION,
      projects: [{ id: "alpha", path: "projects/alpha", extra: true }],
    },
    {
      schema_version: PORTFOLIO_MANIFEST_SCHEMA_VERSION,
      projects: Array.from({ length: 65 }, (_, index) => ({ id: `p-${index}`, path: `p-${index}` })),
    },
  ];

  for (const document of invalidDocuments) {
    await writeManifest(root, document);
    await assert.rejects(() => loadPortfolioManifest(root, "portfolio.json"));
  }
});

test("rejects malformed JSON, invalid UTF-8, and files larger than 256 KiB", async (t) => {
  const root = await fixture(t, "bytes");
  const target = path.join(root, "portfolio.json");
  await fs.writeFile(target, "{not-json");
  await assert.rejects(
    () => loadPortfolioManifest(root, "portfolio.json"),
    (error) => error.code === "invalid_portfolio_manifest_json",
  );

  await fs.writeFile(target, Buffer.from([0xff, 0xfe, 0xfd]));
  await assert.rejects(
    () => loadPortfolioManifest(root, "portfolio.json"),
    (error) => error.code === "invalid_portfolio_manifest_encoding",
  );

  await fs.writeFile(target, Buffer.alloc(MAX_PORTFOLIO_MANIFEST_BYTES + 1, 0x20));
  await assert.rejects(
    () => loadPortfolioManifest(root, "portfolio.json"),
    (error) => error.code === "portfolio_manifest_too_large" && error.statusCode === 413,
  );
});

test("rejects symlinked project paths", async (t) => {
  if (!requireSymlinkSupport(t, "dir")) return;
  const root = await fixture(t, "symlink");
  await fs.symlink(path.join(root, "projects", "alpha"), path.join(root, "projects", "alias"), "dir");
  await writeManifest(root, manifest([{ id: "alias", path: "projects/alias" }]));

  await assert.rejects(
    () => loadPortfolioManifest(root, "portfolio.json"),
    (error) => error.code === "symlink_forbidden" && error.statusCode === 403,
  );
});

test("rejects symlinked manifests", async (t) => {
  if (!requireSymlinkSupport(t, "file")) return;
  const root = await fixture(t, "manifest-symlink");
  await writeManifest(root, manifest(), "real.json");
  await fs.symlink(path.join(root, "real.json"), path.join(root, "portfolio.json"), "file");
  await assert.rejects(
    () => loadPortfolioManifest(root, "portfolio.json"),
    (error) => error.code === "symlink_forbidden" && error.statusCode === 403,
  );
});

test("rejects a symlinked portfolio root", async (t) => {
  const linkType = process.platform === "win32" ? "junction" : "dir";
  if (!requireSymlinkSupport(t, linkType)) return;
  const root = await fixture(t, "root-symlink");
  await writeManifest(root, manifest(), "real.json");
  const alias = `${root}-alias`;
  t.after(() => fs.rm(alias, { force: true }));
  await fs.symlink(root, alias, linkType);
  await assert.rejects(
    () => loadPortfolioManifest(alias, "real.json"),
    (error) => error.code === "portfolio_root_symlink" && error.statusCode === 403,
  );
});

test("rejects a portfolio root reached through a symlinked parent component", async (t) => {
  if (!requireSymlinkSupport(t, "dir")) return;
  const holder = await fs.mkdtemp(path.join(os.tmpdir(), "observatory-portfolio-parent-symlink-"));
  t.after(() => fs.rm(holder, { recursive: true, force: true }));
  const realParent = path.join(holder, "real-parent");
  const root = path.join(realParent, "portfolio");
  await fs.mkdir(path.join(root, "projects", "alpha"), { recursive: true });
  await writeManifest(root, manifest([{ id: "alpha", path: "projects/alpha" }]));
  await fs.symlink(realParent, path.join(holder, "alias-parent"), "dir");

  await assert.rejects(
    () => loadPortfolioManifest(path.join(holder, "alias-parent", "portfolio"), "portfolio.json"),
    (error) => error.code === "portfolio_root_symlink" && error.statusCode === 403,
  );
});

test("detects a manifest replacement after loading", async (t) => {
  const root = await fixture(t, "manifest-boundary");
  await writeManifest(root, manifest([{ id: "alpha", path: "projects/alpha" }]));
  const loaded = await loadPortfolioManifest(root, "portfolio.json");
  await fs.rename(path.join(root, "portfolio.json"), path.join(root, "portfolio.original.json"));
  await writeManifest(root, manifest([{ id: "alpha", path: "projects/alpha" }]));

  await assert.rejects(
    () => assertPortfolioManifestBoundaries(loaded),
    (error) => error.code === "portfolio_manifest_changed" && error.statusCode === 409,
  );
});

test("detects a portfolio-root replacement after loading", async (t) => {
  const root = await fixture(t, "root-boundary");
  await writeManifest(root, manifest([{ id: "alpha", path: "projects/alpha" }]));
  const loaded = await loadPortfolioManifest(root, "portfolio.json");
  const original = `${root}-original`;
  t.after(() => fs.rm(original, { recursive: true, force: true }));
  await fs.rename(root, original);
  await fs.mkdir(root);

  await assert.rejects(
    () => assertPortfolioManifestBoundaries(loaded),
    (error) => error.code === "portfolio_root_changed" && error.statusCode === 409,
  );
});

test("detects manifest and project-root swaps after loading", async (t) => {
  const root = await fixture(t, "boundaries");
  await writeManifest(root, manifest([{ id: "alpha", path: "projects/alpha" }]));
  const loaded = await loadPortfolioManifest(root, "portfolio.json");
  await fs.rename(path.join(root, "projects", "alpha"), path.join(root, "projects", "original"));
  await fs.mkdir(path.join(root, "projects", "alpha"));

  await assert.rejects(
    () => assertPortfolioManifestBoundaries(loaded),
    (error) => error.code === "portfolio_project_root_changed" && error.statusCode === 409,
  );
});

test("fails closed when a project directory swaps between resolution and identity capture", async (t) => {
  const root = await fixture(t, "resolution-race");
  await writeManifest(root, manifest([{ id: "alpha", path: "projects/alpha" }]));
  const projectRoot = path.join(root, "projects", "alpha");
  const originalStat = fs.stat.bind(fs);
  let swapped = false;
  t.mock.method(fs, "stat", async (target, options) => {
    const result = await originalStat(target, options);
    if (!swapped && target === projectRoot && options?.bigint === true) {
      swapped = true;
      await fs.rename(projectRoot, path.join(root, "projects", "alpha-original"));
      await fs.mkdir(projectRoot);
    }
    return result;
  });

  await assert.rejects(
    () => loadPortfolioManifest(root, "portfolio.json"),
    (error) => error.code === "portfolio_project_root_changed" && error.statusCode === 409,
  );
  t.mock.restoreAll();
  assert.equal(swapped, true);
});

test("preserves Windows-sized device and inode identities above 2^53 end to end", async (t) => {
  const root = await fixture(t, "bigint-identities");
  await writeManifest(root, manifest());
  const alpha = path.join(root, "projects", "alpha");
  const beta = path.join(root, "projects", "beta");
  const exact = new Map([
    [root, { dev: 9_007_199_254_740_993n, ino: 9_007_199_254_741_101n }],
    [alpha, { dev: 9_007_199_254_740_993n, ino: 9_007_199_254_741_103n }],
    [beta, { dev: 9_007_199_254_740_993n, ino: 9_007_199_254_741_104n }],
  ]);
  const originalStat = fs.stat.bind(fs);
  t.mock.method(fs, "stat", async (target, options) => {
    const result = await originalStat(target, options);
    const identity = exact.get(String(target));
    if (!identity) return result;
    return statsWithIdentity(result, identity, options?.bigint === true);
  });

  const identity = await captureDirectoryIdentity(alpha);
  assert.equal(identity.device, "9007199254740993");
  assert.equal(identity.inode, "9007199254741103");

  const loaded = await loadPortfolioManifest(root, "portfolio.json");
  assert.deepEqual(loaded.projects.map((project) => project.id), ["alpha", "beta"]);
  await assertPortfolioManifestBoundaries(loaded);
});

function statsWithIdentity(stats, identity, bigint) {
  const clone = Object.create(stats);
  Object.defineProperties(clone, {
    dev: { value: bigint ? identity.dev : Number(identity.dev), enumerable: true },
    ino: { value: bigint ? identity.ino : Number(identity.ino), enumerable: true },
  });
  return clone;
}

test("keeps a project whose folder is missing and marks it unavailable", async (t) => {
  const root = await fixture(t, "missing-folder");
  await writeManifest(root, manifest([
    { id: "alpha", path: "projects/alpha" },
    { id: "gone", path: "projects/gone" },
  ]));

  const loaded = await loadPortfolioManifest(root, "portfolio.json");

  assert.deepEqual(loaded.projects.map((project) => [project.id, project.root === null]), [
    ["alpha", false],
    ["gone", true],
  ]);
  assert.equal(loaded.projects[1].unavailableCode, "project_folder_missing");
  await assertPortfolioManifestBoundaries(loaded);
});

test("manifest errors name the project, the offending value, and forward slashes", async (t) => {
  const root = await fixture(t, "messages");

  await writeManifest(root, manifest([
    { id: "alpha", path: "projects/alpha" },
    { id: "win", path: "projects\\beta" },
  ]));
  await assert.rejects(
    () => loadPortfolioManifest(root, "portfolio.json"),
    (error) => error.code === "invalid_project_path"
      && /Project #2 \(id "win"\)/u.test(error.message)
      && error.message.includes('"projects\\\\beta"')
      && /forward slashes \(\/\)/u.test(error.message),
  );

  await writeManifest(root, manifest([{ id: "bad id!", path: "projects/alpha" }]));
  await assert.rejects(
    () => loadPortfolioManifest(root, "portfolio.json"),
    (error) => error.code === "invalid_project_id"
      && error.message.includes("Project #1")
      && error.message.includes('"bad id!"'),
  );

  await writeManifest(root, manifest([
    { id: "same", path: "projects/alpha" },
    { id: "same", path: "projects/beta" },
  ]));
  await assert.rejects(
    () => loadPortfolioManifest(root, "portfolio.json"),
    (error) => /Project #2 \(id "same"\) repeats an id already used by project #1/u.test(error.message),
  );

  await writeManifest(root, {
    schema_version: PORTFOLIO_MANIFEST_SCHEMA_VERSION,
    projects: [{ id: "alpha", path: "projects/alpha", extra: true }],
  });
  await assert.rejects(
    () => loadPortfolioManifest(root, "portfolio.json"),
    (error) => /Project #1 \(id "alpha"\) has unsupported "extra"/u.test(error.message),
  );

  await writeManifest(root, { schema_version: "portfolio-manifest:v0", projects: [] });
  await assert.rejects(
    () => loadPortfolioManifest(root, "portfolio.json"),
    (error) => error.message.includes('found "portfolio-manifest:v0"'),
  );
});

test("manifest errors never repeat a private location, but keep the project number and id", async (t) => {
  const root = await fixture(t, "private-values");
  const cases = [
    ["/home/alice/private/acme-merger", /an absolute path/u],
    ["\\\\fileserver\\share\\acme-merger", /an absolute path/u],
    ["C:\\Users\\alice\\acme-merger", /an absolute path/u],
    ["C:acme-merger", /an absolute path/u],
    ["~alice/acme-merger", /home folder/u],
    ["$HOME/acme-merger", /a path with a variable/u],
    ["%USERPROFILE%/acme-merger", /a path with a variable/u],
    ["file:///home/alice/acme-merger", /a URL/u],
    [" /home/alice/acme-merger", /an absolute path/u],
  ];
  for (const [projectPath, expected] of cases) {
    await writeManifest(root, manifest([
      { id: "alpha", path: "projects/alpha" },
      { id: "acme", path: projectPath },
    ]));
    await assert.rejects(
      () => loadPortfolioManifest(root, "portfolio.json"),
      (error) => {
        assert.equal(error.code, "invalid_project_path", projectPath);
        assert.match(error.message, /Project #2 \(id "acme"\)/u, projectPath);
        assert.match(error.message, expected, projectPath);
        assert.match(error.message, /value not shown/u, projectPath);
        assert.doesNotMatch(error.message, /alice|acme-merger|USERPROFILE|HOME|fileserver/u, projectPath);
        return true;
      },
    );
  }

  await writeManifest(root, manifest([{ id: "/home/alice/acme-merger", path: "projects/alpha" }]));
  await assert.rejects(
    () => loadPortfolioManifest(root, "portfolio.json"),
    (error) => error.code === "invalid_project_id"
      && error.message.includes("Project #1")
      && !/alice|acme-merger/u.test(error.message),
  );
});
