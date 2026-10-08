import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  CAPABILITY_INVENTORY_SCHEMA_VERSION,
  DEFAULT_CAPABILITY_INVENTORY_POLICY,
  capabilityInventoryPolicyFromConfig,
  collectCapabilityInventory,
  displayInventoryPath,
  normalizeCapabilityInventoryPolicy,
  parseFrontmatter,
  parseMcpJsonServers,
  parseTomlMcpServers,
  sanitizeInlineText,
} from "../../lib/capability-inventory.mjs";
import { validateAgainstSchema } from "../../lib/json-schema-validator.mjs";
import { currentHost, setHost } from "../../lib/runtime/host.mjs";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CREATED = new Set();

function temporaryDirectory(label) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `agentic-sdlc-inventory-${label}-`));
  CREATED.add(directory);
  return fs.realpathSync(directory);
}

test.after(() => {
  for (const directory of CREATED) fs.rmSync(directory, { recursive: true, force: true });
});

function write(root, relativePath, content) {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  return target;
}

function skill(root, relativeDirectory, name, description) {
  const lines = ["---"];
  if (name !== null) lines.push(`name: ${name}`);
  if (description !== null) lines.push(`description: ${description}`);
  lines.push("---", "", "# Body that is never read for the inventory", "");
  return write(root, path.posix.join(relativeDirectory, "SKILL.md"), lines.join("\n"));
}

// Values that must never reach the inventory. They are built at run time so
// no credential-shaped literal sits in the source.
const SENTINELS = Object.freeze({
  env: ["sentinel", "env", "value"].join("_"),
  header: ["sentinel", "header", "value"].join("_"),
  argument: ["sentinel", "argument", "value"].join("_"),
  url: ["sentinel", "endpoint", "value"].join("_"),
});

function buildLayout() {
  const project = temporaryDirectory("project");
  const home = temporaryDirectory("home");

  skill(project, ".claude/skills/alpha-skill", "alpha-skill", "Reviews React components for accessibility.");
  skill(project, ".agents/skills/beta-skill", "beta-skill", "Plans Postgres migrations.");
  write(project, ".claude/commands/ship.md", "---\ndescription: Ship the current branch\n---\nRun the release.\n");
  write(project, ".mcp.json", JSON.stringify({
    mcpServers: {
      "repo-search": {
        command: "node",
        args: ["server.js", `--flag=${SENTINELS.argument}`],
        env: { SERVICE_ENV: SENTINELS.env },
      },
      "remote-docs": {
        type: "http",
        url: `https://example.invalid/${SENTINELS.url}`,
        headers: { Authorization: `Bearer ${SENTINELS.header}` },
      },
      "sse-feed": { type: "sse", url: "https://example.invalid/feed" },
      "switched-off": { command: "node", disabled: true },
    },
  }));
  write(project, ".codex/config.toml", [
    "model = \"example\"",
    "",
    "[mcp_servers.local-tool]",
    "command = \"node\"",
    "args = [",
    "  \"server.js\",",
    `  "--flag=${SENTINELS.argument}",`,
    "]",
    "",
    "[mcp_servers.local-tool.env]",
    `SERVICE_ENV = "${SENTINELS.env}"`,
    "",
    "[mcp_servers.hosted-tool]",
    `url = "https://example.invalid/${SENTINELS.url}"`,
    `http_headers = { Authorization = "Bearer ${SENTINELS.header}" }`,
    "",
    "[mcp_servers.parked-tool]",
    "command = \"node\"",
    "enabled = false",
    "",
  ].join("\n"));

  skill(home, ".claude/skills/gamma-skill", "gamma-skill", "Writes Go services.");
  skill(home, ".codex/skills/delta-skill", "delta-skill", "Operates Terraform stacks.");
  skill(home, ".agents/skills/epsilon-skill", null, "Falls back to the directory name.");

  const firstCache = ".claude/plugins/cache/market";
  write(home, `${firstCache}/widgets/1.2.0/.claude-plugin/plugin.json`, JSON.stringify({
    name: "widgets",
    version: "1.2.0",
    description: "Widget helpers.",
    skills: "./skills/",
    commands: "./commands/",
  }));
  skill(home, `${firstCache}/widgets/1.2.0/skills/widget-skill`, "widget-skill", "Builds widgets for Vue.");
  write(home, `${firstCache}/widgets/1.2.0/commands/widget.md`, "---\ndescription: Make a widget\n---\n");
  write(home, `${firstCache}/widgets/1.10.0/.claude-plugin/plugin.json`, JSON.stringify({
    name: "widgets",
    version: "1.10.0",
    description: "Widget helpers, newest.",
  }));
  skill(home, `${firstCache}/widgets/1.10.0/skills/widget-skill`, "widget-skill", "Builds widgets for Vue, newest.");
  write(home, `${firstCache}/widgets/0.9.0/.claude-plugin/plugin.json`, JSON.stringify({
    name: "widgets",
    version: "0.9.0",
    description: "Widget helpers, oldest.",
  }));

  const secondCache = ".codex/plugins/cache/market";
  write(home, `${secondCache}/gadgets/2.0.0/.codex-plugin/plugin.json`, JSON.stringify({
    name: "gadgets",
    version: "2.0.0",
    description: "Gadget helpers for Rust.",
  }));
  skill(home, `${secondCache}/gadgets/2.0.0/skills/gadget-skill`, "gadget-skill", "Builds gadgets.");

  write(home, ".claude.json", JSON.stringify({
    mcpServers: { "user-tool": { command: "node", env: { SERVICE_ENV: SENTINELS.env } } },
    projects: {
      [project]: { mcpServers: { "local-scope-tool": { type: "stdio", command: "node" } } },
      "/somewhere/else": { mcpServers: { "other-project-tool": { command: "node" } } },
    },
    history: [`remember ${SENTINELS.argument}`],
  }));
  write(home, ".codex/config.toml", [
    "[mcp_servers.\"quoted name\"]",
    "command = \"node\"",
    "[mcp_servers.user-toml-tool]",
    "command = \"node\"",
    "",
  ].join("\n"));
  return { project, home };
}

function inspect(layout, extra = {}) {
  return collectCapabilityInventory({
    projectRoot: layout.project,
    home: layout.home,
    env: {},
    ...extra,
  });
}

function names(entries) {
  return entries.map((entry) => entry.name).sort();
}

test("the template defaults and the built-in defaults describe the same inventory policy", () => {
  for (const file of [
    "templates/sdlc-config.json",
    "templates/workflow-software-project-v3-integration-review/sdlc-config.json",
  ]) {
    const config = JSON.parse(fs.readFileSync(path.join(REPOSITORY_ROOT, file), "utf8"));
    assert.deepEqual(config.capability_discovery_policy.inventory, DEFAULT_CAPABILITY_INVENTORY_POLICY, file);
    assert.deepEqual(capabilityInventoryPolicyFromConfig(config), normalizeCapabilityInventoryPolicy(undefined), file);
  }
});

test("the configuration schema accepts the shipped inventory policy and rejects unsafe or malformed ones", () => {
  const schemaDir = path.join(REPOSITORY_ROOT, "schemas");
  const base = JSON.parse(fs.readFileSync(path.join(REPOSITORY_ROOT, "templates", "sdlc-config.json"), "utf8"));
  const check = (mutate) => {
    const config = structuredClone(base);
    mutate(config.capability_discovery_policy.inventory);
    return validateAgainstSchema(config, "sdlc-config.schema.json", { schemaDir });
  };
  assert.equal(check(() => {}).valid, true);
  for (const good of [".claude/skills", "~/.claude/skills", "${XDG_CONFIG_HOME:-~/.config}/skills", "tools/skills"]) {
    assert.equal(check((inventory) => { inventory.sources[0].path = good; }).valid, true, good);
  }
  const bad = {
    "a parent traversal": (inventory) => { inventory.sources[0].path = "../outside"; },
    "a nested traversal": (inventory) => { inventory.sources[0].path = "a/../../b"; },
    "an absolute path": (inventory) => { inventory.sources[0].path = "/etc"; },
    "a backslash": (inventory) => { inventory.sources[0].path = "a\\b"; },
    "an unknown kind": (inventory) => { inventory.sources[0].kind = "network"; },
    "an unknown scope": (inventory) => { inventory.sources[0].scope = "world"; },
    "an unknown source property": (inventory) => { inventory.sources[0].url = "https://example.invalid"; },
    "a malformed identifier": (inventory) => { inventory.sources[0].id = "Bad Id"; },
    "a missing path": (inventory) => { delete inventory.sources[0].path; },
    "an empty key list": (inventory) => { inventory.sources.find((source) => source.kind === "mcp-json").keys = []; },
    "an unsafe manifest": (inventory) => { inventory.sources.find((source) => source.kind === "plugins").manifests = ["../plugin.json"]; },
    "a variable outside the allowlist": (inventory) => { inventory.sources[0].path = "${FAKE_SECRET_VALUE}.json"; },
    "a variable outside the allowlist in a default": (inventory) => { inventory.sources[0].path = "${HOME:-${FAKE_SECRET_VALUE}}/x"; },
    "a zero limit": (inventory) => { inventory.limits.max_entries = 0; },
    "an unknown limit": (inventory) => { inventory.limits.surprise = 1; },
    "an unknown inventory property": (inventory) => { inventory.network = true; },
    "a non-boolean switch": (inventory) => { inventory.suggest = "yes"; },
    "a non-array alias": (inventory) => { inventory.matching.aliases.go = "golang"; },
  };
  for (const [description, mutate] of Object.entries(bad)) {
    assert.equal(check(mutate).valid, false, `${description} must be rejected`);
  }
});

test("a partial policy keeps the defaults it does not mention and replaces the source list when given", () => {
  const partial = normalizeCapabilityInventoryPolicy({
    limits: { max_entries: 10 },
    matching: { max_suggestions: 2 },
  });
  assert.equal(partial.limits.max_entries, 10);
  assert.equal(partial.limits.max_directories, DEFAULT_CAPABILITY_INVENTORY_POLICY.limits.max_directories);
  assert.equal(partial.matching.max_suggestions, 2);
  assert.deepEqual(partial.matching.ignored_tags, DEFAULT_CAPABILITY_INVENTORY_POLICY.matching.ignored_tags);
  assert.equal(partial.sources.length, DEFAULT_CAPABILITY_INVENTORY_POLICY.sources.length);

  const replaced = normalizeCapabilityInventoryPolicy({
    sources: [{ id: "only", kind: "skills", scope: "project", path: "tools/skills" }],
  });
  assert.deepEqual(replaced.sources.map((source) => source.id), ["only"]);
  assert.equal(normalizeCapabilityInventoryPolicy({ enabled: false }).enabled, false);
  assert.deepEqual(normalizeCapabilityInventoryPolicy(normalizeCapabilityInventoryPolicy({})), normalizeCapabilityInventoryPolicy({}));
});

test("an unsafe or malformed policy is refused before anything is read", () => {
  const source = (overrides) => ({ sources: [{ id: "one", kind: "skills", scope: "project", path: "skills", ...overrides }] });
  assert.throws(() => normalizeCapabilityInventoryPolicy(source({ path: "../outside" })), /without '\.\.' segments/u);
  assert.throws(() => normalizeCapabilityInventoryPolicy(source({ path: "a/../../b" })), /without '\.\.' segments/u);
  assert.throws(() => normalizeCapabilityInventoryPolicy(source({ path: "/etc" })), /without '\.\.' segments/u);
  assert.throws(() => normalizeCapabilityInventoryPolicy(source({ path: "a\\b" })), /without '\.\.' segments/u);
  assert.throws(() => normalizeCapabilityInventoryPolicy(source({ kind: "network" })), /must be one of/u);
  assert.throws(() => normalizeCapabilityInventoryPolicy(source({ scope: "world" })), /must be one of/u);
  assert.throws(() => normalizeCapabilityInventoryPolicy(source({ id: "Bad Id" })), /lower-case identifier/u);
  assert.throws(() => normalizeCapabilityInventoryPolicy(source({ unknown: true })), /unsupported property/u);
  assert.throws(
    () => normalizeCapabilityInventoryPolicy({ sources: [source({}).sources[0], source({}).sources[0]] }),
    /repeats the id/u,
  );
  assert.throws(() => normalizeCapabilityInventoryPolicy({ limits: { max_entries: 0 } }), /between 1 and/u);
  assert.throws(() => normalizeCapabilityInventoryPolicy({ limits: { surprise: 1 } }), /unsupported property/u);
  assert.throws(() => normalizeCapabilityInventoryPolicy({ extra: true }), /unsupported property/u);
  assert.throws(() => normalizeCapabilityInventoryPolicy([]), /must be an object/u);
});

test("front matter understands plain, quoted, folded, and literal scalars and ignores the rest", () => {
  assert.deepEqual(parseFrontmatter("---\nname: plain\ndescription: A plain value # comment\n---\nbody"), {
    name: "plain",
    description: "A plain value",
  });
  assert.deepEqual(parseFrontmatter("---\nname: \"quoted\"\ndescription: 'it''s fine'\n---\n"), {
    name: "quoted",
    description: "it's fine",
  });
  assert.deepEqual(parseFrontmatter("---\nname: folded\ndescription: >-\n  first line\n  second line\n\nother: x\n---\n"), {
    name: "folded",
    description: "first line second line",
  });
  assert.deepEqual(parseFrontmatter("---\nname: literal\ndescription: |\n  one\n  two\n---\n"), {
    name: "literal",
    description: "one two",
  });
  assert.deepEqual(parseFrontmatter("---\nname: wrapped\ndescription: \"starts here\n  and ends here\"\n---\n"), {
    name: "wrapped",
    description: "starts here and ends here",
  });
  assert.deepEqual(parseFrontmatter("---\nname: continued\ndescription: one\n  two\n  three\n---\n"), {
    name: "continued",
    description: "one two three",
  });
  assert.deepEqual(parseFrontmatter("---\ndescription:\n  - not text\nname: listed\n---\n"), { name: "listed" });
  assert.deepEqual(parseFrontmatter("---\nmetadata:\n  name: nested\nname: top\n---\n"), { name: "top" });
  assert.deepEqual(parseFrontmatter("﻿---\r\nname: crlf\r\ndescription: windows line endings\r\n---\r\n"), {
    name: "crlf",
    description: "windows line endings",
  });
  assert.deepEqual(parseFrontmatter("---\nname: unterminated\ndescription: cut off by the byte limit"), {
    name: "unterminated",
    description: "cut off by the byte limit",
  });
  assert.equal(parseFrontmatter("# No front matter\nname: ignored"), null);
  assert.equal(parseFrontmatter(""), null);
});

test("descriptions are reduced to one safe line of bounded length", () => {
  assert.equal(sanitizeInlineText("  many \n\t spaces\u0007here  ", 50), "many spaces here");
  assert.equal(sanitizeInlineText("", 10), null);
  assert.equal(sanitizeInlineText(null, 10), null);
  assert.equal(sanitizeInlineText("abcdefghij", 10), "abcdefghij");
  assert.equal(sanitizeInlineText("abcdefghijk", 10), "abcdefghi…");
});

test("TOML servers are read by table name without keeping any value", () => {
  const document = [
    "# comment",
    "[mcp_servers.alpha]",
    "command = \"run\"",
    "args = [\"--a\", \"[not a header]\"]",
    "[mcp_servers.alpha.env]",
    "VALUE = \"x\"",
    "[mcp_servers.\"beta server\"]",
    "url = \"https://example.invalid\" # trailing",
    "[mcp_servers.gamma]",
    "transport = \"sse\"",
    "url = \"https://example.invalid\"",
    "[mcp_servers.delta]",
    "command = \"run\"",
    "enabled = false",
    "[mcp_servers.epsilon]",
    "note = \"\"\"",
    "[mcp_servers.fake]",
    "command = \"never\"",
    "\"\"\"",
    "command = \"run\"",
    "[[mcp_servers.arrayed]]",
    "command = \"run\"",
    "[other_table.zeta]",
    "command = \"run\"",
    "",
  ].join("\n");
  const servers = parseTomlMcpServers(document, "mcp_servers");
  assert.deepEqual(servers, [
    { name: "alpha", transport: "stdio", enabled: true },
    { name: "gamma", transport: "sse", enabled: true },
    { name: "delta", transport: "stdio", enabled: false },
    { name: "epsilon", transport: "stdio", enabled: true },
  ]);
  assert.equal(JSON.stringify(servers).includes("beta"), false, "a name with a space is not a valid entry name");
  assert.deepEqual(parseTomlMcpServers("[custom.one]\ncommand = \"x\"\n", "custom"), [
    { name: "one", transport: "stdio", enabled: true },
  ]);
  assert.deepEqual(parseTomlMcpServers("not toml at all [[[", "mcp_servers"), []);
});

test("JSON servers keep only the name, transport type, and disabled flag", () => {
  const document = JSON.stringify({
    mcpServers: {
      a: { command: "x", env: { SERVICE_ENV: SENTINELS.env } },
      b: { type: "http", url: "https://example.invalid", headers: { Authorization: SENTINELS.header } },
      c: { url: "https://example.invalid" },
      d: { transport: "streamable-http" },
      e: { command: "x", disabled: true },
      "bad name": { command: "x" },
      f: "not an object",
      __proto__: { command: "x" },
    },
    nested: { deeper: { g: { command: "x" } } },
  });
  const servers = parseMcpJsonServers(document, [["mcpServers"], ["nested", "deeper"]]);
  assert.deepEqual(servers, [
    { name: "a", transport: "stdio", enabled: true },
    { name: "b", transport: "http", enabled: true },
    { name: "c", transport: "http", enabled: true },
    { name: "d", transport: "http", enabled: true },
    { name: "e", transport: "stdio", enabled: false },
    { name: "g", transport: "stdio", enabled: true },
  ]);
  assert.equal(JSON.stringify(servers).includes("sentinel"), false);
  assert.equal(parseMcpJsonServers("{ not json", [["mcpServers"]]), null);
  assert.deepEqual(parseMcpJsonServers("{}", [["mcpServers"]]), []);
  assert.deepEqual(
    parseMcpJsonServers(JSON.stringify({ projects: { "/p": { mcpServers: { z: { command: "x" } } } } }), [["projects", "{project_root}", "mcpServers"]], { project_roots: ["/p", "/p"] }),
    [{ name: "z", transport: "stdio", enabled: true }],
  );
});

test("project and user layouts for both host families are discovered with portable paths", () => {
  const layout = buildLayout();
  const inventory = inspect(layout);

  assert.equal(inventory.schema_version, CAPABILITY_INVENTORY_SCHEMA_VERSION);
  assert.equal(inventory.enabled, true);
  assert.equal(inventory.truncated, false);

  assert.deepEqual(names(inventory.skills), [
    "alpha-skill",
    "beta-skill",
    "delta-skill",
    "epsilon-skill",
    "gadget-skill",
    "gamma-skill",
    "widget-skill",
  ]);
  const skillByName = new Map(inventory.skills.map((entry) => [entry.name, entry]));
  assert.deepEqual(
    {
      path: skillByName.get("alpha-skill").path,
      scope: skillByName.get("alpha-skill").scope,
      description: skillByName.get("alpha-skill").description,
      plugin: skillByName.get("alpha-skill").plugin,
    },
    {
      path: ".claude/skills/alpha-skill/SKILL.md",
      scope: "project",
      description: "Reviews React components for accessibility.",
      plugin: null,
    },
  );
  assert.equal(skillByName.get("beta-skill").path, ".agents/skills/beta-skill/SKILL.md");
  assert.equal(skillByName.get("gamma-skill").path, "~/.claude/skills/gamma-skill/SKILL.md");
  assert.equal(skillByName.get("gamma-skill").scope, "user");
  assert.equal(skillByName.get("delta-skill").path, "~/.codex/skills/delta-skill/SKILL.md");
  assert.equal(skillByName.get("epsilon-skill").path, "~/.agents/skills/epsilon-skill/SKILL.md");
  assert.equal(skillByName.get("gadget-skill").plugin, "gadgets");
  assert.equal(skillByName.get("gadget-skill").path, "~/.codex/plugins/cache/market/gadgets/2.0.0/skills/gadget-skill/SKILL.md");
  assert.equal(skillByName.get("widget-skill").plugin, "widgets");
  assert.equal(skillByName.get("widget-skill").description, "Builds widgets for Vue, newest.");

  assert.deepEqual(names(inventory.commands), ["ship"]);
  assert.deepEqual(inventory.plugins.map((plugin) => [plugin.name, plugin.version, plugin.skills, plugin.commands]), [
    ["widgets", "1.10.0", 1, 0],
    ["gadgets", "2.0.0", 1, 0],
  ]);
  assert.equal(inventory.plugins[0].path, "~/.claude/plugins/cache/market/widgets/1.10.0");

  const servers = new Map(inventory.mcp.map((server) => [server.name, server]));
  assert.deepEqual([...servers.keys()].sort(), [
    "hosted-tool",
    "local-scope-tool",
    "local-tool",
    "parked-tool",
    "remote-docs",
    "repo-search",
    "sse-feed",
    "switched-off",
    "user-toml-tool",
    "user-tool",
  ]);
  assert.equal(servers.get("repo-search").transport, "stdio");
  assert.equal(servers.get("remote-docs").transport, "http");
  assert.equal(servers.get("sse-feed").transport, "sse");
  assert.equal(servers.get("hosted-tool").transport, "http");
  assert.equal(servers.get("local-tool").transport, "stdio");
  assert.equal(servers.get("local-scope-tool").transport, "stdio");
  assert.equal(servers.get("switched-off").enabled, false);
  assert.equal(servers.get("parked-tool").enabled, false);
  assert.equal(servers.get("repo-search").path, ".mcp.json");
  assert.equal(servers.get("local-tool").path, ".codex/config.toml");
  assert.equal(servers.get("user-tool").path, "~/.claude.json");
  assert.equal(servers.get("user-toml-tool").path, "~/.codex/config.toml");
  assert.equal(servers.has("other-project-tool"), false, "another project's local servers are not this project's");

  assert.deepEqual(inventory.counts, {
    skills: inventory.skills.length,
    commands: inventory.commands.length,
    plugins: inventory.plugins.length,
    mcp: inventory.mcp.length,
  });
  const statuses = new Map(inventory.sources.map((entry) => [entry.id, entry.status]));
  assert.equal(statuses.get("project-claude-skills"), "read");
  assert.equal(statuses.get("user-claude-plugins"), "read");
  assert.equal(statuses.get("user-claude-settings"), "missing");
});

test("nothing that can hold a secret reaches the inventory, and no absolute path does", () => {
  const layout = buildLayout();
  const serialized = JSON.stringify(inspect(layout));
  for (const [kind, sentinel] of Object.entries(SENTINELS)) {
    assert.equal(serialized.includes(sentinel), false, `${kind} value leaked into the inventory`);
  }
  assert.equal(serialized.includes(layout.project), false, "an absolute project path leaked");
  assert.equal(serialized.includes(layout.home), false, "an absolute home path leaked");
  assert.doesNotMatch(serialized, /example\.invalid|Bearer|Authorization|SERVICE_ENV|server\.js/u);
  for (const server of inspect(layout).mcp) {
    assert.deepEqual(Object.keys(server).sort(), ["enabled", "name", "path", "scope", "source", "transport", "type"]);
  }
});

test("a host-relocated directory is honoured and shown as an external location", () => {
  const layout = buildLayout();
  const relocated = temporaryDirectory("relocated");
  skill(relocated, "skills/moved-skill", "moved-skill", "Lives outside the home directory.");
  const inventory = inspect(layout, { env: { CLAUDE_CONFIG_DIR: relocated } });
  const moved = inventory.skills.find((entry) => entry.name === "moved-skill");
  assert.ok(moved, "the relocated skills directory is read");
  assert.match(moved.path, /^\(external\)\/.*moved-skill\/SKILL\.md$/u);
  assert.equal(inventory.skills.some((entry) => entry.name === "gamma-skill"), false, "the default location is no longer read");
  const everyPath = [
    ...inventory.sources,
    ...inventory.skills,
    ...inventory.commands,
    ...inventory.plugins,
    ...inventory.mcp,
  ].map((entry) => entry.path);
  assert.ok(everyPath.length > 0);
  assert.equal(everyPath.some((value) => path.isAbsolute(value)), false, "no path is reported as absolute");
});

test("configuration overrides choose exactly which locations are read", () => {
  const layout = buildLayout();
  const custom = {
    sources: [
      { id: "team-skills", kind: "skills", scope: "project", path: "tools/skills" },
      { id: "user-codex-skills", kind: "skills", scope: "user", path: "~/.codex/skills" },
      { id: "off", kind: "skills", scope: "project", path: ".claude/skills", enabled: false },
    ],
  };
  skill(layout.project, "tools/skills/team-skill", "team-skill", "A skill kept in the repository.");
  const inventory = inspect(layout, { policy: custom });
  assert.deepEqual(names(inventory.skills), ["delta-skill", "team-skill"]);
  assert.deepEqual(inventory.sources.map((entry) => [entry.id, entry.status]), [
    ["team-skills", "read"],
    ["user-codex-skills", "read"],
    ["off", "disabled"],
  ]);
  assert.deepEqual(inventory.mcp, []);

  const disabled = inspect(layout, { policy: { enabled: false } });
  assert.equal(disabled.enabled, false);
  assert.deepEqual(disabled.sources, []);
  assert.deepEqual(disabled.counts, { skills: 0, commands: 0, plugins: 0, mcp: 0 });
});

test("plugin manifests can name their own skill and command directories", () => {
  const home = temporaryDirectory("manifest-home");
  const project = temporaryDirectory("manifest-project");
  const root = ".claude/plugins/cache/market/custom/1.0.0";
  write(home, `${root}/.claude-plugin/plugin.json`, JSON.stringify({
    name: "custom",
    version: "1.0.0",
    skills: ["./abilities/", "../escape"],
    commands: "./actions",
  }));
  skill(home, `${root}/abilities/ability-one`, "ability-one", "Lives in a named directory.");
  skill(home, `${root}/skills/default-skill`, "default-skill", "Not named by the manifest.");
  write(home, `${root}/actions/act.md`, "---\ndescription: Act now\n---\n");
  const inventory = collectCapabilityInventory({ projectRoot: project, home, env: {} });
  assert.deepEqual(names(inventory.skills), ["ability-one"]);
  assert.deepEqual(names(inventory.commands), ["act"]);
  assert.deepEqual(inventory.plugins.map((plugin) => [plugin.name, plugin.skills, plugin.commands]), [["custom", 1, 1]]);
});

test("limits cap the result and report it as truncated", () => {
  const layout = buildLayout();
  const inventory = inspect(layout, { policy: { limits: { max_entries: 3 } } });
  assert.equal(inventory.truncated, true);
  assert.equal(inventory.skills.length + inventory.commands.length + inventory.plugins.length + inventory.mcp.length, 3);

  const shortDescription = inspect(layout, { policy: { limits: { max_description_chars: 10 } } });
  for (const entry of shortDescription.skills) {
    if (entry.description) assert.ok(Array.from(entry.description).length <= 10, entry.description);
  }
});

test("unreadable or oversized configuration is reported without its content", () => {
  const home = temporaryDirectory("broken-home");
  const project = temporaryDirectory("broken-project");
  write(project, ".mcp.json", `{ "mcpServers": ${SENTINELS.env}`);
  write(home, ".codex/config.toml", `${"x".repeat(2048)}\n`);
  const inventory = collectCapabilityInventory({
    projectRoot: project,
    home,
    env: {},
    policy: { limits: { max_config_bytes: 1024 } },
  });
  const statuses = new Map(inventory.sources.map((entry) => [entry.id, entry.status]));
  assert.equal(statuses.get("project-mcp-json"), "error");
  assert.equal(statuses.get("user-codex-config"), "skipped");
  assert.equal(JSON.stringify(inventory).includes(SENTINELS.env), false);
  assert.ok(inventory.warnings.some((warning) => /project-mcp-json/u.test(warning)));
  assert.deepEqual(inventory.mcp, []);
});

test("a project location cannot reach outside the project through a link", (t) => {
  const project = temporaryDirectory("link-project");
  const outside = temporaryDirectory("link-outside");
  skill(outside, "skills/stolen-skill", "stolen-skill", "Outside the project.");
  try {
    fs.symlinkSync(path.join(outside, "skills"), path.join(project, ".claude-skills-link"), "dir");
    fs.mkdirSync(path.join(project, ".claude"), { recursive: true });
    fs.symlinkSync(path.join(outside, "skills"), path.join(project, ".claude", "skills"), "dir");
  } catch {
    t.skip("symbolic links are not available");
    return;
  }
  const inventory = collectCapabilityInventory({ projectRoot: project, home: temporaryDirectory("link-home"), env: {} });
  assert.deepEqual(inventory.skills, []);
  assert.equal(inventory.sources.find((entry) => entry.id === "project-claude-skills").status, "skipped");
  assert.ok(inventory.warnings.some((warning) => /links outside the project/u.test(warning)));
});

test("an unset environment reference skips the location instead of guessing", () => {
  const project = temporaryDirectory("unset-project");
  const policy = { sources: [{ id: "needs-env", kind: "skills", scope: "user", path: "${XDG_CONFIG_HOME}/skills" }] };
  const withoutVariable = collectCapabilityInventory({ projectRoot: project, home: project, env: {}, policy });
  assert.equal(withoutVariable.sources[0].status, "unset");
  const root = temporaryDirectory("env-root");
  skill(root, "skills/env-skill", "env-skill", "Found through the variable.");
  const withVariable = collectCapabilityInventory({
    projectRoot: project,
    home: project,
    env: { XDG_CONFIG_HOME: root },
    policy,
  });
  assert.deepEqual(names(withVariable.skills), ["env-skill"]);
  const noHome = collectCapabilityInventory({ projectRoot: project, home: null, env: {} });
  assert.equal(noHome.sources.find((entry) => entry.id === "user-claude-skills").status, "unset");
});

test("home, environment, and files come from the runtime host", () => {
  const layout = buildLayout();
  const real = currentHost();
  const restore = setHost({
    os: { ...real.os, homedir: () => layout.home },
    process: new Proxy(real.process, {
      get(target, property) {
        if (property === "env") return {};
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }),
  });
  try {
    const inventory = collectCapabilityInventory({ projectRoot: layout.project });
    assert.ok(inventory.skills.some((entry) => entry.path === "~/.claude/skills/gamma-skill/SKILL.md"));
  } finally {
    restore();
  }

  const reads = [];
  const spied = setHost({
    fs: new Proxy(real.fs, {
      get(target, property) {
        const value = Reflect.get(target, property, target);
        if (property === "readdirSync" || property === "openSync") {
          return (...args) => {
            reads.push(String(args[0]));
            return value.apply(target, args);
          };
        }
        return typeof value === "function" ? value.bind(target) : value;
      },
    }),
  });
  try {
    collectCapabilityInventory({ projectRoot: layout.project, home: layout.home, env: {} });
  } finally {
    spied();
  }
  assert.ok(reads.some((entry) => entry.includes(layout.home)), "user locations are read through the host file system");
  assert.ok(reads.every((entry) => entry.startsWith(layout.project) || entry.startsWith(layout.home)));
});

test("display paths are project-relative, home-relative, or a short external marker", () => {
  const context = { projectRoot: "/work/project", home: "/home/person" };
  assert.equal(displayInventoryPath("/work/project/.claude/skills/a/SKILL.md", context), ".claude/skills/a/SKILL.md");
  assert.equal(displayInventoryPath("/home/person/.codex/skills/b/SKILL.md", context), "~/.codex/skills/b/SKILL.md");
  assert.equal(displayInventoryPath("/work/project", context), ".");
  assert.equal(displayInventoryPath("/home/person", context), "~");
  assert.equal(displayInventoryPath("/opt/shared/skills/c/SKILL.md", context), "(external)/skills/c/SKILL.md");
  const nested = { projectRoot: "/home/person/project", home: "/home/person" };
  assert.equal(displayInventoryPath("/home/person/project/.mcp.json", nested), ".mcp.json");
  assert.equal(displayInventoryPath("/home/person/.claude.json", nested), "~/.claude.json");
});

test("only allowlisted environment variables can appear in a source path", () => {
  const source = (template) => ({ sources: [{ id: "one", kind: "skills", scope: "user", path: template }] });
  for (const name of ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "HOME", "USERPROFILE", "XDG_CONFIG_HOME", "APPDATA"]) {
    assert.doesNotThrow(() => normalizeCapabilityInventoryPolicy(source(`\${${name}:-~/x}/skills`)), name);
  }
  assert.throws(() => normalizeCapabilityInventoryPolicy(source("${FAKE_SECRET_VALUE}.json")), /using only the variables/u);
  assert.throws(() => normalizeCapabilityInventoryPolicy(source("a/${lower}/b")), /using only the variables/u);

  // Defence in depth: a policy that bypassed validation still never expands the variable.
  const project = temporaryDirectory("env-project");
  const secret = ["sentinel", "env", "path"].join("_");
  const inventory = collectCapabilityInventory({
    projectRoot: project,
    home: project,
    env: { FAKE_SECRET_VALUE: secret },
    policy: { sources: [{ id: "one", kind: "skills", scope: "user", path: "~/skills" }] },
  });
  assert.equal(JSON.stringify(inventory).includes(secret), false);
});

test("a symbolic link to SKILL.md cannot pull in a file from outside the project", (t) => {
  const project = temporaryDirectory("skill-link-project");
  const outside = temporaryDirectory("skill-link-outside");
  skill(outside, "elsewhere", "stolen-skill", "Description that must not be read.");
  fs.mkdirSync(path.join(project, ".claude", "skills", "linked"), { recursive: true });
  fs.mkdirSync(path.join(project, ".claude", "plugins-root"), { recursive: true });
  try {
    fs.symlinkSync(path.join(outside, "elsewhere", "SKILL.md"), path.join(project, ".claude", "skills", "linked", "SKILL.md"));
  } catch {
    t.skip("symbolic links are not available");
    return;
  }
  skill(project, ".claude/skills/honest", "honest", "Inside the project.");
  const inventory = collectCapabilityInventory({ projectRoot: project, home: temporaryDirectory("skill-link-home"), env: {} });
  assert.deepEqual(names(inventory.skills), ["honest"]);
  assert.equal(JSON.stringify(inventory).includes("must not be read"), false);
});

test("a very large directory is examined only up to the listing cap and reported as truncated", () => {
  const project = temporaryDirectory("many-project");
  const root = path.join(project, ".claude", "skills");
  fs.mkdirSync(root, { recursive: true });
  for (let index = 0; index < 60; index += 1) fs.mkdirSync(path.join(root, `empty-${String(index).padStart(3, "0")}`));
  skill(project, ".claude/skills/zzz-late", "zzz-late", "Sorts after the cap.");
  const capped = collectCapabilityInventory({
    projectRoot: project,
    home: temporaryDirectory("many-home"),
    env: {},
    policy: { limits: { max_listing_names: 50 } },
  });
  assert.equal(capped.truncated, true);
  assert.deepEqual(capped.skills, [], "names beyond the cap are never reached");
  assert.ok(capped.warnings.some((warning) => /only the first 50 names were examined/u.test(warning)));

  const uncapped = collectCapabilityInventory({ projectRoot: project, home: temporaryDirectory("many-home"), env: {} });
  assert.equal(uncapped.truncated, false);
  assert.deepEqual(names(uncapped.skills), ["zzz-late"]);
  assert.throws(() => normalizeCapabilityInventoryPolicy({ limits: { max_listing_names: 0 } }), /between 1 and/u);
});

test("descriptions lose bidirectional and zero-width characters", () => {
  const hostile = "safe\u202Etext\u200B hidden\u2066 \uFEFFmarks\u200F";
  assert.equal(sanitizeInlineText(hostile, 100), "safetext hidden marks");
});

test("the project key of a user settings file is found in either path separator form", () => {
  const home = temporaryDirectory("slash-home");
  const project = temporaryDirectory("slash-project");
  const windowsStyle = project.split("/").join("\\");
  write(home, ".claude.json", JSON.stringify({
    projects: { [windowsStyle]: { mcpServers: { "backslash-tool": { command: "node" } } } },
  }));
  // The project root as the host would see it on a platform with backslashes.
  const servers = parseMcpJsonServers(
    fs.readFileSync(path.join(home, ".claude.json"), "utf8"),
    [["projects", "{project_root}", "mcpServers"]],
    { project_roots: [project, windowsStyle.split("\\").join("/"), windowsStyle] },
  );
  assert.deepEqual(servers.map((server) => server.name), ["backslash-tool"]);
  write(home, ".claude.json", JSON.stringify({
    projects: { [project]: { mcpServers: { "slash-tool": { command: "node" } } } },
  }));
  const found = collectCapabilityInventory({ projectRoot: project, home, env: {} });
  assert.deepEqual(found.mcp.map((server) => server.name), ["slash-tool"]);
});
