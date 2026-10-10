import "../helpers/test-isolation.mjs";

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { checkAttention } from "../../lib/messaging/attention.mjs";
import { messageIdentity, messageSend, messageWho } from "../../lib/messaging/commands.mjs";
import { defaultName, resolveIdentity } from "../../lib/messaging/identity.mjs";
import { joinsToWelcome } from "../../lib/messaging/join.mjs";
import { buildRoster, nameTakenBy } from "../../lib/messaging/roster.mjs";
import { VERSION } from "../../lib/engine/definitions.mjs";
import { createGithubProvider, fromGithubComment, toGithubBody } from "../../lib/messaging/providers/github.mjs";
import { createFakeGh } from "../helpers/fake-gh.mjs";

const REPO = "acme/shop";

function clone({ gitUser = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-id-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  if (gitUser) execFileSync("git", ["config", "user.name", gitUser], { cwd: root });
  fs.mkdirSync(path.join(root, ".git/agentic-sdlc"));
  fs.writeFileSync(path.join(root, ".git/agentic-sdlc/messaging.json"), JSON.stringify({ provider: "github", repo: REPO, issue: 1 }));
  return root;
}

function channel() {
  const gh = createFakeGh({ issues: [{ number: 1, title: "t", state: "open", labels: [] }], nextIssue: 2, start: Date.now(), login: "alice" });
  return { gh, providers: { github: () => createGithubProvider({ exec: gh.exec }) } };
}

const envOf = (host, extra = {}) => ({ AGENTIC_SDLC_HOST_LABEL: host, ...extra });
const bodies = (gh) => gh.state.comments.map((comment) => comment.body);
const kindsOf = (gh) => gh.state.comments.map((comment) => /"kind":"(\w+)"/u.exec(comment.body)?.[1]);

test("default name: git user and host, else the host; an explicit name wins and is checked", async () => {
  assert.equal(defaultName("Antonio", "pc-b7b5ff"), "Antonio · pc-b7b5ff");
  assert.equal(defaultName(null, "pc-b7b5ff"), "pc-b7b5ff");
  assert.equal(resolveIdentity(clone(), envOf("PC3")).name, "PC3");
  const root = clone({ gitUser: "Antonio Antenore" });
  const identity = resolveIdentity(root, envOf("PC3"));
  assert.equal(identity.name, "Antonio Antenore · PC3");
  assert.equal(identity.named, false);
  const named = await messageIdentity({ root, name: "Antonio · PC3", json: true }, envOf("PC3"));
  assert.equal(named.name, "Antonio · PC3");
  assert.equal(resolveIdentity(root, envOf("PC3")).named, true);
  await assert.rejects(messageIdentity({ root, name: "bad*name" }, envOf("PC3")), /1-64 characters/u);
});

test("a name already used by another computer is refused", async () => {
  const { gh, providers } = channel();
  const other = clone();
  await messageSend({ root: other, text: "hi", json: true }, envOf("PC2"), providers);
  const root = clone();
  await assert.rejects(messageIdentity({ root, name: "PC2" }, envOf("PC3"), providers), /already used by the computer PC2/u);
  // A name stored by hand is caught by the join of the next command.
  const file = path.join(root, ".git/agentic-sdlc/messaging.json");
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, "utf8")), identity: { name: "PC2" } }));
  await assert.rejects(messageSend({ root, text: "x" }, envOf("PC3"), providers), /already used by the computer PC2/u);
  assert.equal(gh.state.comments.filter((comment) => /"host":"PC3"/u.test(comment.body)).length, 0);
});

test("a sender that is not this computer's name is refused", async () => {
  const { providers } = channel();
  const root = clone();
  await assert.rejects(messageSend({ root, text: "hi", sender: "PC9", json: true }, envOf("PC1", { AGENTIC_SDLC_MESSAGING_JOIN: "off" }), providers), /--sender 'PC9' is not accepted/u);
  const same = await messageSend({ root, text: "hi", sender: "PC1", json: true }, envOf("PC1", { AGENTIC_SDLC_MESSAGING_JOIN: "off" }), providers);
  assert.equal(same.from, "PC1");
});

test("the header shows name and login, the trailer keeps host and login; old messages read without a name", () => {
  const body = toGithubBody({ from: "Antonio · PC3", host: "PC3", ghLogin: "antonio", kind: "question", story: "ST-X-001", text: "ok?", version: VERSION, stories: ["ST-X-001"] }, "abc");
  assert.match(body, /^\*\*Antonio · PC3\*\* \(antonio\) · question · ST-X-001\n\nok\?/u);
  const parsed = fromGithubComment({ id: 5, body, created_at: "2026-01-01T00:00:00Z", user: { login: "antonio" } });
  assert.deepEqual([parsed.from, parsed.host, parsed.gh_login, parsed.stories], ["Antonio · PC3", "PC3", "antonio", ["ST-X-001"]]);
  const old = fromGithubComment({ id: 6, body: "**pc-aa11**\n\nold\n\n<!-- agentic-sdlc:{\"v\":1,\"id\":\"x\",\"from\":\"pc-aa11\"} -->", created_at: "2026-01-01T00:00:00Z", user: { login: "bob" } });
  assert.equal(old.from, "pc-aa11");
  assert.equal(old.host, null);
  const roster = buildRoster([old]);
  assert.equal(roster.participants[0].name, "pc-aa11");
});

test("the first command joins once per name and version", async () => {
  const { gh, providers } = channel();
  const root = clone({ gitUser: "Antonio" });
  await messageSend({ root, text: "one", json: true }, envOf("PC3"), providers);
  await messageSend({ root, text: "two", json: true }, envOf("PC3"), providers);
  assert.deepEqual(kindsOf(gh), ["join", "info", "info"]);
  assert.match(bodies(gh)[0], /^\*\*Antonio · PC3\*\* \(alice\) · join/u);
  assert.match(bodies(gh)[0], /si è unito al canale \(versione /u);
  // A new name joins again.
  await messageIdentity({ root, name: "Antonio · Studio" }, envOf("PC3"), providers);
  await messageSend({ root, text: "three", json: true }, envOf("PC3"), providers);
  assert.deepEqual(kindsOf(gh).filter((kind) => kind === "join").length, 2);
  // And a new plugin version.
  const file = path.join(root, ".git/agentic-sdlc/messaging.json");
  const stored = JSON.parse(fs.readFileSync(file, "utf8"));
  stored.identity.joined.version = "0.0.1";
  fs.writeFileSync(file, JSON.stringify(stored));
  await messageSend({ root, text: "four", json: true }, envOf("PC3"), providers);
  assert.equal(kindsOf(gh).filter((kind) => kind === "join").length, 3);
  await assert.rejects(messageSend({ root, text: "x", kind: "join" }, envOf("PC3"), providers), /sent by the plugin itself/u);
});

test("the other computers welcome a join once, and the roster lists everybody", async () => {
  const { gh, providers } = channel();
  const a = clone();
  const b = clone();
  await messageSend({ root: a, text: "hello", json: true }, envOf("PC1"), providers);
  const first = await checkAttention(b, { env: envOf("PC2"), providers });
  assert.match(first, /PC1 si è unito al canale \(versione /u);
  assert.deepEqual(kindsOf(gh), ["join", "info", "welcome"]);
  assert.match(bodies(gh)[2], /^\*\*PC2\*\*/u);
  assert.match(bodies(gh)[2], /"reply_to":"\d+"/u);
  // Same computer, later poll: no second welcome.
  const state = path.join(b, ".git/agentic-sdlc/messaging-auto.json");
  const saved = JSON.parse(fs.readFileSync(state, "utf8"));
  saved.attention.last_poll = 0;
  fs.writeFileSync(state, JSON.stringify(saved));
  await checkAttention(b, { env: envOf("PC2"), providers });
  assert.equal(kindsOf(gh).filter((kind) => kind === "welcome").length, 1);
  // The joiner never welcomes itself.
  const own = await checkAttention(a, { env: envOf("PC1"), providers });
  assert.equal(kindsOf(gh).filter((kind) => kind === "welcome").length, 1);
  assert.doesNotMatch(String(own), /si è unito/u);
  const who = await messageWho({ root: a, json: true }, envOf("PC1"), providers);
  assert.deepEqual(who.participants.map((entry) => entry.name).sort(), ["PC1", "PC2"]);
  assert.deepEqual(who.duplicates, []);
});

test("joinsToWelcome skips own joins, welcomed joins and old joins", () => {
  const identity = { name: "PC2", host: "PC2", gh_login: null };
  const now = Date.parse("2026-10-10T12:00:00Z");
  const iso = (ms) => new Date(now - ms).toISOString();
  const messages = [
    { id: "1", kind: "join", from: "PC1", host: "PC1", time: iso(1000) },
    { id: "2", kind: "join", from: "PC2", host: "PC2", time: iso(1000) },
    { id: "3", kind: "join", from: "PC4", host: "PC4", time: iso(1000) },
    { id: "4", kind: "join", from: "PC5", host: "PC5", time: iso(48 * 3600_000) },
  ];
  assert.deepEqual(joinsToWelcome({ messages, identity, welcomed: new Set(["3"]), now }).map((m) => m.id), ["1"]);
});

test("roster: stories, last activity, duplicate names and old versions", () => {
  const at = (n) => `2026-10-10T12:0${n}:00Z`;
  const messages = [
    { id: "1", plugin_message: true, kind: "join", from: "Ann", host: "h1", version: "0.113.0", stories: ["ST-A-001"], time: at(1) },
    { id: "2", plugin_message: true, kind: "welcome", from: "Ann", host: "h2", version: "0.110.0", stories: [], time: at(2) },
    { id: "3", plugin_message: true, kind: "info", from: "Bob", host: "h3", version: "0.113.0", stories: ["ST-B-001", "ST-B-002"], time: at(3) },
    { id: "4", plugin_message: false, kind: "info", from: "human", time: at(4) },
  ];
  const roster = buildRoster(messages, { currentVersion: "0.113.0" });
  assert.deepEqual(roster.duplicates, ["Ann"]);
  assert.equal(roster.participants.length, 3);
  const h2 = roster.participants.find((entry) => entry.host === "h2");
  assert.deepEqual([h2.duplicate, h2.outdated], [true, true]);
  assert.deepEqual(roster.participants.find((entry) => entry.host === "h3").stories, ["ST-B-001", "ST-B-002"]);
  assert.equal(nameTakenBy(messages, "Ann", "h1").host, "h2");
  assert.equal(nameTakenBy(messages, "Zed", "h1"), null);
});

test("keep-going notes a recent join of another computer, once it is in the window", async () => {
  const { recentJoins } = await import("../../lib/host-hooks/keep-going.mjs");
  const now = Date.now();
  const state = { own: ["9"], attention: { window: [
    { id: "1", kind: "join", from: "Ann", version: "0.114.0", time: new Date(now - 60_000).toISOString() },
    { id: "9", kind: "join", from: "Me", version: "0.114.0", time: new Date(now - 60_000).toISOString() },
    { id: "2", kind: "join", from: "Old", version: "0.1.0", time: new Date(now - 3_600_000).toISOString() },
  ] } };
  assert.deepEqual(recentJoins(state, "Me", now), ["Ann si è unito al canale (versione 0.114.0)"]);
});
