import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { startObservatoryServer } from "../../lib/change-observatory/server.mjs";
import { liveRefreshSeconds } from "../../lib/change-observatory/cli.mjs";
import { ObservatoryApi } from "../../ui/change-observatory/api.js";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "observatory-refresh-"));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  await fs.mkdir(path.join(root, ".sdlc"), { recursive: true });
  await writeProject(root, "First name");
  return root;
}

function writeProject(root, name) {
  return fs.writeFile(path.join(root, ".sdlc", "project.json"), `${JSON.stringify({
    schema_version: "0.1.0",
    project_id: "refresh-fixture",
    project_name: name,
  })}\n`, "utf8");
}

function get(running, requestPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const outgoing = http.request({
      host: running.address.host,
      port: running.address.port,
      path: requestPath,
      headers: {
        Host: `${running.address.host}:${running.address.port}`,
        Authorization: `Bearer ${running.accessToken}`,
        ...headers,
      },
    }, (incoming) => {
      const chunks = [];
      incoming.on("data", (chunk) => chunks.push(chunk));
      incoming.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        resolve({
          statusCode: incoming.statusCode,
          headers: incoming.headers,
          json: body && incoming.headers["content-type"]?.startsWith("application/json") ? JSON.parse(body) : null,
        });
      });
    });
    outgoing.on("error", reject);
    outgoing.end();
  });
}

test("the data endpoint returns changed records without restarting the server", async (t) => {
  const root = await fixture(t);
  const running = await startObservatoryServer({ projectRoot: root, port: 0 });
  t.after(() => running.close());

  const first = await get(running, "/api/v1/observatory");
  assert.equal(first.statusCode, 200);
  assert.equal(first.json.project.name, "First name");
  assert.equal(first.headers["cache-control"], "no-store");

  const unchanged = await get(running, "/api/v1/observatory", { "If-None-Match": first.headers.etag });
  assert.equal(unchanged.statusCode, 304);

  await writeProject(root, "Second name");
  const second = await get(running, "/api/v1/observatory", { "If-None-Match": first.headers.etag });
  assert.equal(second.statusCode, 200);
  assert.equal(second.json.project.name, "Second name");
  assert.notEqual(second.headers.etag, first.headers.etag);
});

test("refresh endpoint catches the record source up, is no-store and token protected", async (t) => {
  const root = await fixture(t);
  const calls = [];
  const running = await startObservatoryServer({
    projectRoot: root,
    port: 0,
    refreshSource: async (mode) => { calls.push(mode); },
    sourceRef: () => ({ mode: "ref", ref: "origin/main", commit: "abc" }),
    liveRefreshSeconds: 5,
  });
  t.after(() => running.close());

  const full = await get(running, "/api/v1/refresh");
  assert.equal(full.statusCode, 200);
  assert.equal(full.headers["cache-control"], "no-store");
  assert.equal(full.json.source.ref, "origin/main");
  assert.ok(!Number.isNaN(Date.parse(full.json.refreshedAt)));

  const local = await get(running, "/api/v1/refresh?fetch=0");
  assert.equal(local.statusCode, 200);
  assert.deepEqual(calls, [{ fetch: true }, { fetch: false }]);

  const invalid = await get(running, "/api/v1/refresh?x=1");
  assert.equal(invalid.statusCode, 400);

  const unauthenticated = await get(running, "/api/v1/refresh", { Authorization: "Bearer wrong-token-value" });
  assert.ok([401, 403].includes(unauthenticated.statusCode));
  assert.equal(calls.length, 2);

  const source = await get(running, "/api/v1/source-ref");
  assert.equal(source.json.liveSeconds, 5);
});

test("live polling interval is configurable with a safe default", () => {
  assert.equal(liveRefreshSeconds({}), 8);
  assert.equal(liveRefreshSeconds({ AGENTIC_SDLC_OBSERVE_LIVE_SECONDS: "15" }), 15);
  assert.equal(liveRefreshSeconds({ AGENTIC_SDLC_OBSERVE_LIVE_SECONDS: "0" }), 8);
  assert.equal(liveRefreshSeconds({ AGENTIC_SDLC_OBSERVE_LIVE_SECONDS: "abc" }), 8);
});

test("UI api refresh calls the refresh endpoint uncached and tolerates older servers", async () => {
  const urls = [];
  const api = new ObservatoryApi({
    accessToken: "token-token-token-token-token-token-1234",
    fetchImpl: async (url, init) => {
      urls.push([url, init.cache]);
      return new Response(JSON.stringify({ schemaVersion: "x" }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  await api.refreshSource();
  await api.refreshSource({ fetchRemote: false });
  assert.deepEqual(urls, [["/api/v1/refresh", "no-store"], ["/api/v1/refresh?fetch=0", "no-store"]]);

  const old = new ObservatoryApi({
    accessToken: "token-token-token-token-token-token-1234",
    fetchImpl: async () => new Response("{}", { status: 404, headers: { "content-type": "application/json" } }),
  });
  assert.equal(await old.refreshSource(), null);
});
