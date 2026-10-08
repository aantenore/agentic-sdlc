import assert from "node:assert/strict";
import crypto from "node:crypto";
import { rmSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  computeCanonicalRevision,
  createObservatoryModelCache,
  shouldUseSynchronousMetadataValidation,
} from "../../lib/change-observatory/model-cache.mjs";
import { OBSERVATORY_WORKER_MARKER } from "../../lib/change-observatory/runtime.mjs";

test("synchronous metadata validation is restricted to the dedicated Windows worker", () => {
  assert.equal(shouldUseSynchronousMetadataValidation({
    platform: "win32",
    environment: { [OBSERVATORY_WORKER_MARKER]: "1" },
  }), true);
  assert.equal(shouldUseSynchronousMetadataValidation({
    platform: "win32",
    environment: {},
  }), false);
  assert.equal(shouldUseSynchronousMetadataValidation({
    platform: "darwin",
    environment: { [OBSERVATORY_WORKER_MARKER]: "1" },
  }), false);
  assert.equal(shouldUseSynchronousMetadataValidation({
    platform: "win32",
    environment: Object.create({ [OBSERVATORY_WORKER_MARKER]: "1" }),
  }), false);
  assert.throws(
    () => shouldUseSynchronousMetadataValidation(null),
    /runtime override must be an object/u,
  );
  assert.throws(
    () => shouldUseSynchronousMetadataValidation({ platform: "win32", environment: [] }),
    /runtime environment must be an object/u,
  );
});

test("canonical revisions track source bytes but ignore derived cache and index data", async (t) => {
  const fixture = await createCacheFixture(t);
  const initial = await computeCanonicalRevision(fixture.projectRoot);

  await fs.mkdir(path.join(fixture.projectRoot, ".sdlc", "cache"), { recursive: true });
  await fs.mkdir(path.join(fixture.projectRoot, ".sdlc", "InDeXeS"), { recursive: true });
  await fs.writeFile(path.join(fixture.projectRoot, ".sdlc", "cache", "derived.json"), "{\"v\":1}\n");
  await fs.writeFile(path.join(fixture.projectRoot, ".sdlc", "InDeXeS", "derived.json"), "{\"v\":2}\n");
  assert.equal(await computeCanonicalRevision(fixture.projectRoot), initial);

  await writeProjectRecord(fixture.projectRoot, { version: 2 });
  assert.notEqual(await computeCanonicalRevision(fixture.projectRoot), initial);

  const limitedInitial = await computeCanonicalRevision(fixture.projectRoot, {
    limits: { maxFileBytes: 1 },
  });
  await writeProjectRecord(fixture.projectRoot, { version: 3 });
  assert.equal(
    await computeCanonicalRevision(fixture.projectRoot, { limits: { maxFileBytes: 1 } }),
    limitedInitial,
  );
  await writeProjectRecord(fixture.projectRoot, { version: 30 });
  assert.notEqual(
    await computeCanonicalRevision(fixture.projectRoot, { limits: { maxFileBytes: 1 } }),
    limitedInitial,
  );
});

test("structured stat signatures preserve canonical revision bytes for ASCII and Unicode paths", async (t) => {
  const fixture = await createCacheFixture(t);
  assert.equal(
    await computeCanonicalRevision(fixture.projectRoot),
    "ad048030affb2833a823d71ea862079464232cd1818d5b1733fd291c2db5bda8",
  );

  // Keep this fixture inside the BMP. Node.js 18 on Windows can reject a
  // non-BMP path while its temporary parent is being finalized, which tests
  // the runner rather than the cache's UTF-8 canonicalization.
  const unicodeDirectory = path.join(fixture.projectRoot, ".sdlc", "data-東京-鉄道");
  await fs.mkdir(unicodeDirectory);
  await fs.writeFile(
    path.join(unicodeDirectory, "record-β.json"),
    `${JSON.stringify({ city: "東京", emoji: "🚆" })}\n`,
    "utf8",
  );

  const unicodeRevision = await computeCanonicalRevision(fixture.projectRoot);
  assert.equal(
    unicodeRevision,
    "e627a95b2d1da928c7989e77e5e99ef12c96a5592d48438dac6025be239b8cc4",
  );
  assert.equal(await computeCanonicalRevision(fixture.projectRoot), unicodeRevision);
});

test("compact directory snapshots preserve the observable digest and canonical revision", async (t) => {
  const fixture = await createCacheFixture(t);
  const initial = await computeCanonicalRevision(fixture.projectRoot);
  const observed = [];
  const instrumented = await computeCanonicalRevision(fixture.projectRoot, {
    onDirectorySnapshot(snapshot) {
      observed.push(snapshot);
    },
  });

  assert.equal(instrumented, initial);
  assert.deepEqual(observed, [{
    path: ".sdlc",
    snapshot: "760c5adfbcd9c4a00c1079a9a52d9e5eed72200ec8eb11b05ed6ba72ee375a68",
  }]);
  assert.equal(Object.isFrozen(observed[0]), true);
});

test("ordered directory snapshots reject add, remove, rename, or type-change races", async (t) => {
  const scenarios = [
    {
      name: "add",
      async mutate(knowledgeBase) {
        await fs.writeFile(path.join(knowledgeBase, "added-during-scan.json"), "{}\n", "utf8");
      },
    },
    {
      name: "remove",
      prepare: true,
      async mutate(knowledgeBase) {
        await fs.rm(path.join(knowledgeBase, "race-target.json"));
      },
    },
    {
      name: "rename",
      prepare: true,
      async mutate(knowledgeBase) {
        await fs.rename(
          path.join(knowledgeBase, "race-target.json"),
          path.join(knowledgeBase, "renamed-during-scan.json"),
        );
      },
    },
    {
      name: "type-change",
      prepare: true,
      async mutate(knowledgeBase) {
        const target = path.join(knowledgeBase, "race-target.json");
        await fs.rm(target);
        await fs.mkdir(target);
      },
    },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async (scenarioTest) => {
      const fixture = await createCacheFixture(scenarioTest);
      const knowledgeBase = path.join(fixture.projectRoot, ".sdlc");
      if (scenario.prepare) {
        await fs.writeFile(path.join(knowledgeBase, "race-target.json"), "{}\n", "utf8");
      }
      let mutated = false;
      await assert.rejects(
        () => computeCanonicalRevision(fixture.projectRoot, {
          async onDirectorySnapshot(snapshot) {
            if (snapshot.path !== ".sdlc" || mutated) return;
            mutated = true;
            await scenario.mutate(knowledgeBase);
          },
        }),
        (error) => error?.code === "canonical_revision_changed" && error?.statusCode === 409,
      );
      assert.equal(typeof await computeCanonicalRevision(fixture.projectRoot), "string");
    });
  }
});

test("canonical hashing stops when a file grows beyond its captured signature", async (t) => {
  const fixture = await createCacheFixture(t);
  let target = path.join(fixture.projectRoot, ".sdlc", "growing.json");
  await fs.writeFile(target, `{"value":"${"A".repeat(130_000)}"}\n`, "utf8");
  target = await fs.realpath(target);
  let appended = false;

  await assert.rejects(
    () => computeCanonicalRevision(fixture.projectRoot, {
      async onFileReadChunk(event) {
        if (event.path !== target || appended) return;
        appended = true;
        await fs.appendFile(target, "B".repeat(130_000), "utf8");
      },
    }),
    (error) => error?.code === "canonical_revision_changed" && error?.statusCode === 409,
  );
  assert.equal(appended, true);
});

test("revision markers stop at maxFiles and maxTotalBytes", async (t) => {
  const fixture = await createCacheFixture(t);
  const projectPath = path.join(fixture.projectRoot, ".sdlc", "project.json");
  const ignoredPath = path.join(fixture.projectRoot, ".sdlc", "z-ignored.json");
  await fs.writeFile(ignoredPath, "{\"value\":1}\n", "utf8");

  const fileLimited = await computeCanonicalRevision(fixture.projectRoot, {
    limits: { maxFiles: 1 },
  });
  await fs.writeFile(ignoredPath, "{\"value\":2}\n", "utf8");
  assert.equal(
    await computeCanonicalRevision(fixture.projectRoot, { limits: { maxFiles: 1 } }),
    fileLimited,
  );
  await writeProjectRecord(fixture.projectRoot, { version: 2 });
  assert.notEqual(
    await computeCanonicalRevision(fixture.projectRoot, { limits: { maxFiles: 1 } }),
    fileLimited,
  );

  const projectBytes = (await fs.stat(projectPath)).size;
  const totalLimited = await computeCanonicalRevision(fixture.projectRoot, {
    limits: { maxTotalBytes: projectBytes },
  });
  await fs.writeFile(ignoredPath, "{\"value\":3}\n", "utf8");
  assert.equal(
    await computeCanonicalRevision(fixture.projectRoot, {
      limits: { maxTotalBytes: projectBytes },
    }),
    totalLimited,
  );
});

test("aggregate maxEntries bounds wide directories and invalidates overflow snapshots", async (t) => {
  const fixture = await createCacheFixture(t);
  const wideDirectory = path.join(fixture.projectRoot, ".sdlc", "z-wide");
  await fs.mkdir(wideDirectory);
  const ignored = [];
  for (let index = 0; index < 3; index += 1) {
    const target = path.join(wideDirectory, `ignored-${index}.bin`);
    ignored.push(target);
    await fs.writeFile(target, "x\n", "utf8");
  }

  const limits = { maxEntries: 4 };
  const limitedRevision = await computeCanonicalRevision(fixture.projectRoot, { limits });
  assert.equal(
    await computeCanonicalRevision(fixture.projectRoot, { limits }),
    limitedRevision,
  );

  let builds = 0;
  const cache = createObservatoryModelCache({
    projectRoot: fixture.projectRoot,
    limits,
    validationRuntime: {
      platform: "win32",
      environment: { [OBSERVATORY_WORKER_MARKER]: "1" },
    },
    buildModel() {
      builds += 1;
      return { builds };
    },
  });
  await cache.get();
  await cache.get();
  assert.equal(builds, 1);

  await fs.rm(ignored.at(-1));
  assert.notEqual(
    await computeCanonicalRevision(fixture.projectRoot, { limits }),
    limitedRevision,
  );
  await cache.get();
  assert.equal(builds, 2);
});

test("unreadable canonical entries use a stable marker and recover when readable", async (t) => {
  if (process.platform === "win32" || process.getuid?.() === 0) {
    t.skip("Portable permission denial is unavailable on this runtime");
    return;
  }

  const fixture = await createCacheFixture(t);
  const unreadablePath = path.join(fixture.projectRoot, ".sdlc", "unreadable.json");
  await fs.writeFile(unreadablePath, "{\"secret\":true}\n", "utf8");
  await fs.chmod(unreadablePath, 0o000);
  t.after(() => fs.chmod(unreadablePath, 0o600).catch(() => {}));

  const unreadable = await computeCanonicalRevision(fixture.projectRoot);
  assert.equal(await computeCanonicalRevision(fixture.projectRoot), unreadable);

  let builds = 0;
  const cache = createObservatoryModelCache({
    projectRoot: fixture.projectRoot,
    buildModel() {
      builds += 1;
      return { builds };
    },
  });
  await cache.get();
  await cache.get();
  assert.equal(builds, 1);

  await fs.chmod(unreadablePath, 0o600);
  assert.notEqual(await computeCanonicalRevision(fixture.projectRoot), unreadable);
  await cache.get();
  assert.equal(builds, 2);
});

test("warm reads validate the retained snapshot without rebuilding", async (t) => {
  const fixture = await createCacheFixture(t);
  let builds = 0;
  const events = [];
  const cache = createObservatoryModelCache({
    projectRoot: fixture.projectRoot,
    buildModel() {
      builds += 1;
      return { builds };
    },
    onFastPathCheck(event) {
      events.push(event);
    },
  });

  const cold = await cache.get();
  assert.equal(events.length, 0);
  const warm = await cache.get();
  assert.equal(warm, cold);
  assert.equal(builds, 1);
  assert.ok(events.some((event) => event.event === "start" && event.kind === "file"));
  assert.ok(events.some((event) => event.event === "start" && event.kind === "directory"));
});

test("same-size canonical mutations invalidate a cached model", async (t) => {
  const fixture = await createCacheFixture(t);
  const recordPath = path.join(fixture.projectRoot, ".sdlc", "project.json");
  const before = await fs.stat(recordPath, { bigint: true });
  let builds = 0;
  const cache = createObservatoryModelCache({
    projectRoot: fixture.projectRoot,
    buildModel() {
      builds += 1;
      return readProjectRecord(fixture.projectRoot);
    },
  });
  const initial = await cache.get();

  await writeProjectRecord(fixture.projectRoot, { version: 2 });
  await fs.utimes(recordPath, new Date(), new Date(Date.now() + 60_000));
  const after = await fs.stat(recordPath, { bigint: true });
  assert.equal(after.size, before.size);
  assert.notEqual(after.mtimeNs, before.mtimeNs);

  const refreshed = await cache.get();
  assert.equal(builds, 2);
  assert.notEqual(refreshed, initial);
  assert.notEqual(refreshed.etag, initial.etag);
  assert.equal(JSON.parse(refreshed.body.toString("utf8")).version, 2);
});

test("same-inode rewrites invalidate a cached model when size and mtime are restored", async (t) => {
  const fixture = await createCacheFixture(t);
  const recordPath = path.join(fixture.projectRoot, ".sdlc", "same-size.json");
  const fixedTime = new Date("2024-01-02T03:04:05.000Z");
  await fs.writeFile(recordPath, '{"value":"AAAA"}\n', "utf8");
  await fs.utimes(recordPath, fixedTime, fixedTime);
  const before = await fs.stat(recordPath, { bigint: true });
  let builds = 0;
  const cache = createObservatoryModelCache({
    projectRoot: fixture.projectRoot,
    async buildModel() {
      builds += 1;
      return JSON.parse(await fs.readFile(recordPath, "utf8"));
    },
  });
  const initial = await cache.get();
  assert.equal(JSON.parse(initial.body.toString("utf8")).value, "AAAA");

  await new Promise((resolve) => setTimeout(resolve, 10));
  await fs.writeFile(recordPath, '{"value":"BBBB"}\n', "utf8");
  await fs.utimes(recordPath, fixedTime, fixedTime);
  const after = await fs.stat(recordPath, { bigint: true });
  assert.equal(after.dev, before.dev);
  assert.equal(after.ino, before.ino);
  assert.equal(after.size, before.size);
  assert.equal(after.mtimeNs, before.mtimeNs);
  assert.notEqual(after.ctimeNs, before.ctimeNs);

  const refreshed = await cache.get();
  assert.equal(builds, 2);
  assert.notEqual(refreshed, initial);
  assert.notEqual(refreshed.etag, initial.etag);
  assert.equal(JSON.parse(refreshed.body.toString("utf8")).value, "BBBB");
});

test("metadata-only drift refreshes signatures without changing content revision", async (t) => {
  const fixture = await createCacheFixture(t);
  const recordPath = path.join(fixture.projectRoot, ".sdlc", "project.json");
  let builds = 0;
  const cache = createObservatoryModelCache({
    projectRoot: fixture.projectRoot,
    buildModel() {
      builds += 1;
      return { builds };
    },
  });
  const initial = await cache.get();
  const initialRevision = await computeCanonicalRevision(fixture.projectRoot);
  const before = await fs.stat(recordPath, { bigint: true });

  await fs.utimes(recordPath, new Date(), new Date(Date.now() + 60_000));
  const after = await fs.stat(recordPath, { bigint: true });
  assert.notEqual(after.mtimeNs, before.mtimeNs);
  assert.equal(await computeCanonicalRevision(fixture.projectRoot), initialRevision);

  assert.equal(await cache.get(), initial);
  assert.equal(await cache.get(), initial);
  assert.equal(builds, 1);
});

test("directory timestamp drift does not invalidate an unchanged entry snapshot", async (t) => {
  const fixture = await createCacheFixture(t);
  const knowledgeBase = path.join(fixture.projectRoot, ".sdlc");
  let builds = 0;
  const cache = createObservatoryModelCache({
    projectRoot: fixture.projectRoot,
    buildModel() {
      builds += 1;
      return { builds };
    },
  });
  const initial = await cache.get();

  await fs.utimes(knowledgeBase, new Date(), new Date(Date.now() + 60_000));

  assert.equal(await cache.get(), initial);
  assert.equal(builds, 1);
});

test("unchanged signatures reuse previous digests without reading file bodies", async (t) => {
  const fixture = await createCacheFixture(t);
  const recordPath = path.join(fixture.projectRoot, ".sdlc", "project.json");
  let builds = 0;
  const cache = createObservatoryModelCache({
    projectRoot: fixture.projectRoot,
    buildModel() {
      builds += 1;
      return { builds };
    },
  });
  const initial = await cache.get();

  const sampleHandle = await fs.open(recordPath, "r");
  const fileHandlePrototype = Object.getPrototypeOf(sampleHandle);
  await sampleHandle.close();
  const nativeRead = fileHandlePrototype.read;
  let bodyReads = 0;
  fileHandlePrototype.read = function countedRead(...args) {
    bodyReads += 1;
    return nativeRead.apply(this, args);
  };
  try {
    const derivedDirectory = path.join(fixture.projectRoot, ".sdlc", "cache");
    await fs.mkdir(derivedDirectory);
    await fs.writeFile(path.join(derivedDirectory, "derived.json"), "{}\n", "utf8");
    assert.equal(await cache.get(), initial);
  } finally {
    fileHandlePrototype.read = nativeRead;
  }

  assert.equal(bodyReads, 0);
  assert.equal(builds, 1);
});

test("fast validation invalidates add, remove, rename, content, and symlink changes", async (t) => {
  const scenarios = [
    {
      name: "add",
      async mutate(fixture) {
        await fs.writeFile(path.join(fixture.projectRoot, ".sdlc", "added.json"), "{}\n", "utf8");
      },
    },
    {
      name: "remove",
      async prepare(fixture) {
        await fs.writeFile(path.join(fixture.projectRoot, ".sdlc", "victim.json"), "{}\n", "utf8");
      },
      async mutate(fixture) {
        await fs.rm(path.join(fixture.projectRoot, ".sdlc", "victim.json"));
      },
    },
    {
      name: "rename",
      async prepare(fixture) {
        await fs.writeFile(path.join(fixture.projectRoot, ".sdlc", "before.json"), "{}\n", "utf8");
      },
      async mutate(fixture) {
        await fs.rename(
          path.join(fixture.projectRoot, ".sdlc", "before.json"),
          path.join(fixture.projectRoot, ".sdlc", "after.json"),
        );
      },
    },
    {
      name: "content",
      async mutate(fixture) {
        await writeProjectRecord(fixture.projectRoot, { version: 200 });
      },
    },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async (scenarioTest) => {
      const fixture = await createCacheFixture(scenarioTest);
      await scenario.prepare?.(fixture);
      let builds = 0;
      let fastChecks = 0;
      const cache = createObservatoryModelCache({
        projectRoot: fixture.projectRoot,
        buildModel() {
          builds += 1;
          return { builds };
        },
        onFastPathCheck(event) {
          if (event.event === "start") fastChecks += 1;
        },
      });
      const initial = await cache.get();
      await scenario.mutate(fixture);
      const refreshed = await cache.get();
      assert.ok(fastChecks > 0);
      assert.equal(builds, 2);
      assert.notEqual(refreshed.etag, initial.etag);
    });
  }

  await t.test("symlink", async (scenarioTest) => {
    if (process.platform === "win32") {
      scenarioTest.skip("Symlink retargeting requires Unix semantics");
      return;
    }
    const fixture = await createCacheFixture(scenarioTest);
    await fs.writeFile(path.join(fixture.projectRoot, "target-a.json"), "{}\n", "utf8");
    await fs.writeFile(path.join(fixture.projectRoot, "target-b.json"), "{}\n", "utf8");
    const link = path.join(fixture.projectRoot, ".sdlc", "linked.json");
    await fs.symlink("../target-a.json", link, "file");
    let builds = 0;
    const cache = createObservatoryModelCache({
      projectRoot: fixture.projectRoot,
      buildModel() {
        builds += 1;
        return { builds };
      },
    });
    const initial = await cache.get();
    await fs.rm(link);
    await fs.symlink("../target-b.json", link, "file");
    const refreshed = await cache.get();
    assert.equal(builds, 2);
    assert.notEqual(refreshed.etag, initial.etag);
  });
});

test("dedicated Windows sync validation preserves file and directory invalidation", async (t) => {
  const runtime = {
    platform: "win32",
    environment: { [OBSERVATORY_WORKER_MARKER]: "1" },
  };
  const scenarios = [
    {
      name: "file-content",
      async mutate(fixture) {
        await writeProjectRecord(fixture.projectRoot, { version: 400 });
      },
    },
    {
      name: "nested-directory-entry",
      async prepare(fixture) {
        const directory = path.join(fixture.projectRoot, ".sdlc", "nested");
        await fs.mkdir(directory);
        await fs.writeFile(path.join(directory, "first.json"), "{}\n", "utf8");
      },
      async mutate(fixture) {
        await fs.writeFile(
          path.join(fixture.projectRoot, ".sdlc", "nested", "added.json"),
          "{}\n",
          "utf8",
        );
      },
    },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async (scenarioTest) => {
      const fixture = await createCacheFixture(scenarioTest);
      await scenario.prepare?.(fixture);
      let builds = 0;
      const cache = createObservatoryModelCache({
        projectRoot: fixture.projectRoot,
        validationRuntime: runtime,
        buildModel() {
          builds += 1;
          return { builds };
        },
      });
      const initial = await cache.get();
      assert.equal(await cache.get(), initial);
      await scenario.mutate(fixture);
      const refreshed = await cache.get();
      assert.equal(builds, 2);
      assert.notEqual(refreshed.etag, initial.etag);
      assert.equal(await cache.get(), refreshed);
    });
  }

  await t.test("symlink-fallback", async (scenarioTest) => {
    if (process.platform === "win32") {
      scenarioTest.skip("Symlink retargeting requires Unix semantics");
      return;
    }
    const fixture = await createCacheFixture(scenarioTest);
    await fs.writeFile(path.join(fixture.projectRoot, "target-a.json"), "{}\n", "utf8");
    await fs.writeFile(path.join(fixture.projectRoot, "target-b.json"), "{}\n", "utf8");
    const link = path.join(fixture.projectRoot, ".sdlc", "linked.json");
    await fs.symlink("../target-a.json", link, "file");
    let builds = 0;
    const cache = createObservatoryModelCache({
      projectRoot: fixture.projectRoot,
      validationRuntime: runtime,
      buildModel() {
        builds += 1;
        return { builds };
      },
    });
    const initial = await cache.get();
    assert.equal(await cache.get(), initial);
    await fs.rm(link);
    await fs.symlink("../target-b.json", link, "file");
    const refreshed = await cache.get();
    assert.equal(builds, 2);
    assert.notEqual(refreshed.etag, initial.etag);
  });
});

test("dedicated Windows sync validation detects a file removed between start and check", async (t) => {
  const fixture = await createCacheFixture(t);
  const racePath = path.join(fixture.projectRoot, ".sdlc", "sync-race.json");
  await fs.writeFile(racePath, "{}\n", "utf8");
  const events = [];
  let removed = false;
  let builds = 0;
  const cache = createObservatoryModelCache({
    projectRoot: fixture.projectRoot,
    validationRuntime: {
      platform: "win32",
      environment: { [OBSERVATORY_WORKER_MARKER]: "1" },
    },
    buildModel() {
      builds += 1;
      return { builds };
    },
    onFastPathCheck(event) {
      if (path.basename(event.path) !== path.basename(racePath)) return;
      events.push(event.event);
      if (event.event === "start" && !removed) {
        removed = true;
        rmSync(racePath);
      }
    },
  });

  const initial = await cache.get();
  const refreshed = await cache.get();
  assert.equal(removed, true);
  assert.deepEqual(events, ["start", "end"]);
  assert.equal(builds, 2);
  assert.notEqual(refreshed.etag, initial.etag);
  assert.equal(await cache.get(), refreshed);
  assert.equal(builds, 2);
});

test("warm validation without a hook does not freeze instrumentation events", async (t) => {
  const fixture = await createCacheFixture(t);
  const cache = createObservatoryModelCache({
    projectRoot: fixture.projectRoot,
    buildModel: () => ({ ok: true }),
  });
  const cold = await cache.get();

  const nativeFreeze = Object.freeze;
  let freezes = 0;
  Object.freeze = (value) => {
    freezes += 1;
    return nativeFreeze(value);
  };
  try {
    assert.equal(await cache.get(), cold);
  } finally {
    Object.freeze = nativeFreeze;
  }

  assert.equal(freezes, 0);
});

test("warm validation compares retained directory entries without hashing them again", async (t) => {
  const fixture = await createCacheFixture(t);
  const cache = createObservatoryModelCache({
    projectRoot: fixture.projectRoot,
    buildModel: () => ({ ok: true }),
  });
  const cold = await cache.get();

  const nativeCreateHash = crypto.createHash;
  let hashes = 0;
  crypto.createHash = function countedCreateHash(...args) {
    hashes += 1;
    return nativeCreateHash.apply(this, args);
  };
  try {
    assert.equal(await cache.get(), cold);
  } finally {
    crypto.createHash = nativeCreateHash;
  }

  assert.equal(hashes, 0);
});

test("direct snapshot budget charges two retained cells per entry and one per directory", async (t) => {
  const fixture = await createCacheFixture(t);
  const cellsDirectory = path.join(fixture.projectRoot, ".sdlc", "cells");
  await fs.mkdir(cellsDirectory);
  await fs.writeFile(path.join(cellsDirectory, "one.bin"), "x\n", "utf8");
  let builds = 0;
  const cache = createObservatoryModelCache({
    projectRoot: fixture.projectRoot,
    limits: { maxFiles: 2 },
    buildModel() {
      builds += 1;
      return { builds };
    },
  });
  const cold = await cache.get();

  async function countWarmHashes() {
    const nativeCreateHash = crypto.createHash;
    let hashes = 0;
    crypto.createHash = function countedCreateHash(...args) {
      hashes += 1;
      return nativeCreateHash.apply(this, args);
    };
    try {
      assert.equal(await cache.get(), cold);
    } finally {
      crypto.createHash = nativeCreateHash;
    }
    return hashes;
  }

  assert.equal(await countWarmHashes(), 0);
  await fs.writeFile(path.join(cellsDirectory, "two.bin"), "x\n", "utf8");
  assert.ok(await countWarmHashes() >= 1);
  assert.equal(builds, 1);
  assert.equal(await countWarmHashes(), process.platform === "win32" ? 1 : 0);
});

test("wide and long-name directories use bounded digest snapshots and still invalidate", async (t) => {
  const scenarios = [
    {
      name: "add",
      mutate(fixture) {
        return fs.writeFile(path.join(fixture.wideDirectory, "added.json"), "{}\n", "utf8");
      },
    },
    {
      name: "remove",
      mutate(fixture) {
        return fs.rm(path.join(fixture.wideDirectory, "target.json"));
      },
    },
    {
      name: "type-change",
      async mutate(fixture) {
        const target = path.join(fixture.wideDirectory, "target.json");
        await fs.rm(target);
        await fs.mkdir(target);
      },
    },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async (scenarioTest) => {
      const fixture = await createDigestFallbackFixture(scenarioTest);
      let builds = 0;
      const cache = createObservatoryModelCache({
        projectRoot: fixture.projectRoot,
        limits: { maxFiles: 4 },
        buildModel() {
          builds += 1;
          return { builds };
        },
      });
      const cold = await cache.get();

      const nativeCreateHash = crypto.createHash;
      let hashes = 0;
      crypto.createHash = function countedCreateHash(...args) {
        hashes += 1;
        return nativeCreateHash.apply(this, args);
      };
      try {
        assert.equal(await cache.get(), cold);
      } finally {
        crypto.createHash = nativeCreateHash;
      }
      assert.equal(hashes, process.platform === "win32" ? 2 : 0);

      await scenario.mutate(fixture);
      const refreshed = await cache.get();
      assert.equal(builds, 2);
      assert.notEqual(refreshed.etag, cold.etag);
    });
  }
});

test("bounded digest snapshots preserve callback bytes and reject scan races", async (t) => {
  const fixture = await createDigestFallbackFixture(t);
  const baseline = await computeCanonicalRevision(fixture.projectRoot, {
    limits: { maxFiles: 4 },
  });
  let wideSnapshot = null;
  const instrumented = await computeCanonicalRevision(fixture.projectRoot, {
    limits: { maxFiles: 4 },
    onDirectorySnapshot(snapshot) {
      if (snapshot.path === ".sdlc/wide") wideSnapshot = snapshot.snapshot;
    },
  });

  assert.equal(instrumented, baseline);
  assert.equal(
    wideSnapshot,
    "43707edd94fc4bf2382ab65ac287a90c623a20e73b1ea1ba3e68c2bce5da3800",
  );

  let mutated = false;
  await assert.rejects(
    () => computeCanonicalRevision(fixture.projectRoot, {
      limits: { maxFiles: 4 },
      async onDirectorySnapshot(snapshot) {
        if (snapshot.path !== ".sdlc/wide" || mutated) return;
        mutated = true;
        await fs.writeFile(path.join(fixture.wideDirectory, "raced.json"), "{}\n", "utf8");
      },
    }),
    (error) => error?.code === "canonical_revision_changed" && error?.statusCode === 409,
  );
  assert.equal(mutated, true);
});

test("async validation rescans after an entry disappears during a pooled check", async (t) => {
  const fixture = await createCacheFixture(t);
  const racePath = path.join(fixture.projectRoot, ".sdlc", "race.json");
  await fs.writeFile(racePath, "{}\n", "utf8");
  const events = [];
  let mutated = false;
  let builds = 0;
  const cache = createObservatoryModelCache({
    projectRoot: fixture.projectRoot,
    buildModel() {
      builds += 1;
      return { builds };
    },
    async onFastPathCheck(event) {
      const isRaceTarget = path.basename(event.path) === path.basename(racePath);
      if (isRaceTarget) events.push(event.event);
      if (isRaceTarget && event.event === "start" && !mutated) {
        mutated = true;
        await fs.rm(racePath);
      }
    },
  });

  const initial = await cache.get();
  const refreshed = await cache.get();

  assert.equal(mutated, true);
  assert.deepEqual(events, ["start", "end"]);
  assert.equal(builds, 2);
  assert.notEqual(refreshed, initial);
  assert.notEqual(refreshed.etag, initial.etag);
  assert.equal(await cache.get(), refreshed);
  assert.equal(builds, 2);
});

test("project root removal during fast validation preserves the boundary error", async (t) => {
  const fixture = await createCacheFixture(t);
  const movedRoot = `${fixture.projectRoot}-moved`;
  let moved = false;
  const cache = createObservatoryModelCache({
    projectRoot: fixture.projectRoot,
    buildModel: () => ({ stable: true }),
    async onFastPathCheck(event) {
      if (event.event !== "start" || moved) return;
      moved = true;
      await fs.rename(fixture.projectRoot, movedRoot);
    },
  });

  await cache.get();
  await assert.rejects(
    () => cache.get(),
    (error) => error?.code === "project_boundary_changed" && error?.statusCode === 409,
  );
  assert.equal(moved, true);
});

test("fast validation enforces bounded concurrency", async (t) => {
  const fixture = await createCacheFixture(t);
  for (let index = 0; index < 12; index += 1) {
    await fs.writeFile(
      path.join(fixture.projectRoot, ".sdlc", `record-${String(index).padStart(2, "0")}.json`),
      `${JSON.stringify({ index })}\n`,
      "utf8",
    );
  }

  let active = 0;
  let maximum = 0;
  let starts = 0;
  let ends = 0;
  let builds = 0;
  const eventsByPath = new Map();
  const cache = createObservatoryModelCache({
    projectRoot: fixture.projectRoot,
    validationConcurrency: 3,
    buildModel() {
      builds += 1;
      return { builds };
    },
    async onFastPathCheck(event) {
      assert.equal(Object.isFrozen(event), true);
      const sequence = eventsByPath.get(event.path) ?? [];
      sequence.push(event.event);
      eventsByPath.set(event.path, sequence);
      if (event.event === "start") {
        active += 1;
        starts += 1;
        maximum = Math.max(maximum, active);
        await new Promise((resolve) => setTimeout(resolve, 2));
      } else {
        ends += 1;
        active -= 1;
      }
    },
  });

  const cold = await cache.get();
  const warm = await cache.get();
  assert.equal(warm, cold);
  assert.equal(builds, 1);
  assert.ok(starts > 3);
  assert.equal(ends, starts);
  assert.equal(maximum, 3);
  assert.equal(active, 0);
  for (const sequence of eventsByPath.values()) {
    assert.deepEqual(sequence, ["start", "end"]);
  }
});

test("default fast validation uses the bounded platform filesystem pool", async (t) => {
  const fixture = await createCacheFixture(t);
  const expectedConcurrency = process.platform === "win32" ? 64 : 8;
  for (let index = 0; index < expectedConcurrency + 8; index += 1) {
    await fs.writeFile(
      path.join(fixture.projectRoot, ".sdlc", `default-bound-${String(index).padStart(2, "0")}.json`),
      `${JSON.stringify({ index })}\n`,
      "utf8",
    );
  }

  let active = 0;
  let maximum = 0;
  let starts = 0;
  const cache = createObservatoryModelCache({
    projectRoot: fixture.projectRoot,
    buildModel: () => ({ stable: true }),
    async onFastPathCheck(event) {
      if (event.event === "start") {
        active += 1;
        starts += 1;
        maximum = Math.max(maximum, active);
        await new Promise((resolve) => setTimeout(resolve, 2));
      } else {
        active -= 1;
      }
    },
  });

  const cold = await cache.get();
  assert.equal(await cache.get(), cold);
  assert.ok(starts > expectedConcurrency);
  assert.equal(maximum, expectedConcurrency);
  assert.equal(active, 0);
});

test("model cache is single-flight, reuses serialized bytes, and invalidates by revision", async (t) => {
  const fixture = await createCacheFixture(t);
  let releaseBuild;
  const buildGate = new Promise((resolve) => {
    releaseBuild = resolve;
  });
  let builds = 0;
  const cache = createObservatoryModelCache({
    projectRoot: fixture.projectRoot,
    async buildModel() {
      builds += 1;
      if (builds === 1) await buildGate;
      return readProjectRecord(fixture.projectRoot);
    },
  });

  const pending = Array.from({ length: 24 }, () => cache.get());
  await waitFor(() => builds === 1);
  releaseBuild();
  const entries = await Promise.all(pending);

  assert.equal(builds, 1);
  assert.ok(entries.every((entry) => entry === entries[0]));
  assert.match(entries[0].etag, /^"sha256-[A-Za-z0-9_-]+"$/);
  assert.equal(JSON.parse(entries[0].body.toString("utf8")).version, 1);

  const warm = await cache.get();
  assert.equal(warm, entries[0]);
  assert.equal(builds, 1);

  const concurrentWarm = await Promise.all(Array.from({ length: 24 }, () => cache.get()));
  assert.ok(concurrentWarm.every((entry) => entry === warm));
  assert.equal(builds, 1);

  await fs.mkdir(path.join(fixture.projectRoot, ".sdlc", "cache"), { recursive: true });
  await fs.writeFile(path.join(fixture.projectRoot, ".sdlc", "cache", "temporary.json"), "{}\n");
  assert.equal(await cache.get(), warm);
  assert.equal(builds, 1);

  await writeProjectRecord(fixture.projectRoot, { version: 2 });
  const refreshed = await cache.get();
  assert.equal(builds, 2);
  assert.equal(JSON.parse(refreshed.body.toString("utf8")).version, 2);
  assert.notEqual(refreshed.etag, warm.etag);
});

test("model cache retries a build when canonical evidence changes during normalization", async (t) => {
  const fixture = await createCacheFixture(t);
  let builds = 0;
  const cache = createObservatoryModelCache({
    projectRoot: fixture.projectRoot,
    async buildModel() {
      builds += 1;
      const model = await readProjectRecord(fixture.projectRoot);
      if (builds === 1) {
        await writeProjectRecord(fixture.projectRoot, { version: 2 });
      }
      return model;
    },
  });

  const entry = await cache.get();
  assert.equal(builds, 2);
  assert.equal(JSON.parse(entry.body.toString("utf8")).version, 2);
});

test("failed builds are not cached", async (t) => {
  const fixture = await createCacheFixture(t);
  let builds = 0;
  const cache = createObservatoryModelCache({
    projectRoot: fixture.projectRoot,
    async buildModel() {
      builds += 1;
      if (builds === 1) throw new Error("normalization failed");
      return { ok: true };
    },
  });

  await assert.rejects(() => cache.get(), /normalization failed/);
  assert.equal(JSON.parse((await cache.get()).body.toString("utf8")).ok, true);
  assert.equal(builds, 2);
});

test("a cached model is not served after the canonical knowledge-base boundary becomes a symlink", async (t) => {
  if (process.platform === "win32") {
    t.skip("Knowledge-base swap coverage requires Unix symlink semantics");
    return;
  }

  const fixture = await createCacheFixture(t);
  const cache = createObservatoryModelCache({
    projectRoot: fixture.projectRoot,
    buildModel: () => readProjectRecord(fixture.projectRoot),
  });
  await cache.get();

  const canonical = path.join(fixture.projectRoot, ".sdlc");
  const hidden = path.join(fixture.projectRoot, "hidden-sdlc");
  await fs.rename(canonical, hidden);
  await fs.symlink("hidden-sdlc", canonical, "dir");

  await assert.rejects(
    () => cache.get(),
    (error) => error?.code === "knowledge_base_symlink" && error?.statusCode === 403,
  );
});

async function createCacheFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "change-observatory-model-cache-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const projectRoot = path.join(root, "project");
  await fs.mkdir(path.join(projectRoot, ".sdlc"), { recursive: true });
  await writeProjectRecord(projectRoot, { version: 1 });
  return { projectRoot };
}

async function createDigestFallbackFixture(t) {
  const fixture = await createCacheFixture(t);
  const longNameDirectory = path.join(fixture.projectRoot, ".sdlc", "long");
  const wideDirectory = path.join(fixture.projectRoot, ".sdlc", "wide");
  await fs.mkdir(longNameDirectory);
  await fs.mkdir(wideDirectory);
  for (let index = 0; index < 5; index += 1) {
    const longName = `${"x".repeat(220)}-${String(index).padStart(2, "0")}.bin`;
    await fs.writeFile(path.join(longNameDirectory, longName), "x\n", "utf8");
  }
  for (let index = 0; index < 7; index += 1) {
    await fs.writeFile(
      path.join(wideDirectory, `entry-${String(index).padStart(2, "0")}.bin`),
      "x\n",
      "utf8",
    );
  }
  await fs.writeFile(path.join(longNameDirectory, "target.json"), "{}\n", "utf8");
  await fs.writeFile(path.join(wideDirectory, "target.json"), "{}\n", "utf8");
  return { ...fixture, longNameDirectory, wideDirectory };
}

function writeProjectRecord(projectRoot, data) {
  return fs.writeFile(
    path.join(projectRoot, ".sdlc", "project.json"),
    `${JSON.stringify(data)}\n`,
    "utf8",
  );
}

async function readProjectRecord(projectRoot) {
  return JSON.parse(await fs.readFile(path.join(projectRoot, ".sdlc", "project.json"), "utf8"));
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("Timed out waiting for the model build");
}

test("a record that changes during a build is retried and then marked retryable", async (t) => {
  const fixture = await createCacheFixture(t);
  let builds = 0;
  const pauses = [];
  const cache = createObservatoryModelCache({
    projectRoot: fixture.projectRoot,
    sleep: async (milliseconds) => {
      pauses.push(milliseconds);
    },
    async buildModel() {
      builds += 1;
      // A writer that never stops: every build ends with different records.
      await writeProjectRecord(fixture.projectRoot, { version: 100 + builds });
      return { builds };
    },
  });

  await assert.rejects(
    () => cache.get(),
    (error) => error?.code === "canonical_revision_changed"
      && error?.statusCode === 409
      && error?.retryable === true
      && /kept changing/u.test(error.message),
  );
  // Two stability attempts per read, one initial read plus three retries.
  assert.equal(builds, 8);
  assert.deepEqual(pauses, [25, 50, 75]);
});

test("a write burst that ends within the retry budget still produces a model", async (t) => {
  const fixture = await createCacheFixture(t);
  let builds = 0;
  const cache = createObservatoryModelCache({
    projectRoot: fixture.projectRoot,
    sleep: async () => {},
    stabilityAttempts: 1,
    async buildModel() {
      builds += 1;
      if (builds <= 2) await writeProjectRecord(fixture.projectRoot, { version: 100 + builds });
      return { builds };
    },
  });

  const representation = await cache.get();
  assert.equal(JSON.parse(representation.body.toString("utf8")).builds, 3);
  assert.throws(() => createObservatoryModelCache({
    projectRoot: fixture.projectRoot,
    buildModel() {},
    revisionRetries: 99,
  }), /revisionRetries/u);
});
